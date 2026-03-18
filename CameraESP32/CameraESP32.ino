#include "esp_camera.h"
#include <WiFi.h>
#include <esp_wifi.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "I2CKeyPad.h" 
#include <ESP32Servo.h>
#include "soc/soc.h"             // Cần thiết cho Brownout
#include "soc/rtc_cntl_reg.h"    // Cần thiết cho Brownout
#include <WebServer.h>           // Thư viện cho Local API
#include <ESPmDNS.h>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h> 
#include <freertos/queue.h> 
#include <freertos/semphr.h> 

extern void startCameraServer();

#define NO_KEY '\0' 

// ===========================
// CẤU HÌNH PIN & ĐỊA CHỈ I2C
// ===========================
#define I2C_SDA 13
#define I2C_SCL 15
#define SERVO_PIN 14
#define BUZZER_PIN 12 
#define LCD_ADDR 0x27      
#define KEYPAD_ADDR 0x20  

LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
I2CKeyPad keypad(KEYPAD_ADDR); 
Servo myServo;
WebServer apiServer(8080); // API Server chạy ở cổng 8080

SemaphoreHandle_t i2cMutex;

// --- CÁC BIẾN QUẢN LÝ TRẠNG THÁI HỆ THỐNG ---
enum SystemState {
  STATE_IDLE, 
  STATE_AUTH_OLD_PASS, 
  STATE_ENTER_NEW_PASS, 
  STATE_CONFIRM_NEW_PASS, 
  STATE_LOCKED_OUT 
};

SystemState currentState = STATE_IDLE; 
char tempNewPassword[12] = ""; 
char currentPassword[12] = "1234"; 
char inputBuffer[12] = "";
unsigned long doorOpenMillis = 0;
bool isDoorOpen = false;
int wrongPasswordCount = 0;            
unsigned long lockoutStartTime = 0;    

char keyMap[] = "123A456B789C*0#D"; 

// ===========================
// CẤU HÌNH FREE RTOS & EVENTS
// ===========================
enum EventSource { SRC_KEYPAD, SRC_LOCAL_API };
struct SystemEvent {
  EventSource source;
  char key;
  char cmd[16];
};

QueueHandle_t eventQueue = NULL;

// ===========================
// CẤU HÌNH WIFI
// ===========================
const char* ssid = "Q";
const char* password = "1709200004";

// ===========================
// CẤU HÌNH CAMERA PIN
// ===========================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

volatile bool cameraEnabled = false;

// Khai báo hàm
void displayDefault();
void openDoor();
void closeDoor();
void processCommand(const char* cmd);
void processKey(char key);
void lcdPrint(const char* l1, const char* l2 = "");
bool enqueueRemoteCommand(const char* cmd);

// --- HÀM HELPER MUTEX LCD ---
void lcdPrint(const char* l1, const char* l2) {
  if (xSemaphoreTake(i2cMutex, portMAX_DELAY) == pdTRUE) {
    lcd.clear(); 
    lcd.setCursor(0,0); lcd.print(l1);
    if (l2 && l2[0] != '\0') {
       lcd.setCursor(0,1); lcd.print(l2);
    }
    xSemaphoreGive(i2cMutex);
  }
}

void displayDefault() {
  if (currentState == STATE_LOCKED_OUT) return;

  if (xSemaphoreTake(i2cMutex, portMAX_DELAY) == pdTRUE) {
    lcd.clear();
    lcd.setCursor(0, 0);
    switch(currentState) {
        case STATE_IDLE: lcd.print("Nhap Password:"); break;
        case STATE_AUTH_OLD_PASS: lcd.print("Nhap Pass Cu:"); break;
        case STATE_ENTER_NEW_PASS: lcd.print("Nhap Pass Moi:"); break;
        case STATE_CONFIRM_NEW_PASS: lcd.print("Xac Nhan Lai:"); break;
        default: break;
    }
    lcd.setCursor(0, 1);
    lcd.print(">");
    for(size_t i = 0; i < strlen(inputBuffer); i++) lcd.print("*");
    xSemaphoreGive(i2cMutex);
  }
}

void openDoor() {
  Serial.println(" Cửa mở!");
  digitalWrite(BUZZER_PIN, HIGH);
  vTaskDelay(150 / portTICK_PERIOD_MS);
  digitalWrite(BUZZER_PIN, LOW);

  lcdPrint("DUNG MAT KHAU!", "DANG MO CUA...");
  myServo.write(90); 
  isDoorOpen = true;
  doorOpenMillis = millis();
}

void closeDoor() {
  Serial.println("Cửa đóng!");
  myServo.write(0); 
  isDoorOpen = false;
  inputBuffer[0] = '\0'; 
  displayDefault();
}

// --- HÀM XỬ LÝ LỆNH ---
void processCommand(const char* cmdIn) {
  char cmd[16];
  strncpy(cmd, cmdIn, sizeof(cmd) - 1);
  cmd[sizeof(cmd) - 1] = '\0';

  Serial.print("Nhận lệnh: "); Serial.println(cmd);

  if (strcmp(cmd, "UNLOCK") == 0) {
    if (currentState == STATE_LOCKED_OUT) return;
    openDoor();
  }
  else if (strcmp(cmd, "CAM_ON") == 0 && !cameraEnabled) {
    lcdPrint("DANG BAT CAM...", "");
    cameraEnabled = true;
    vTaskDelay(500 / portTICK_PERIOD_MS); // Chờ xíu cho người dùng đọc được chữ
    displayDefault();
  } 
  else if (strcmp(cmd, "CAM_OFF") == 0 && cameraEnabled) {
    lcdPrint("DANG TAT CAM...", "");
    cameraEnabled = false;
    vTaskDelay(500 / portTICK_PERIOD_MS); 
    displayDefault();
  }
}

bool enqueueRemoteCommand(const char* cmd) {
  if (!cmd || cmd[0] == '\0' || !eventQueue) return false;
  SystemEvent evt;
  evt.source = SRC_LOCAL_API;
  evt.key = 0;
  strncpy(evt.cmd, cmd, sizeof(evt.cmd) - 1);
  evt.cmd[sizeof(evt.cmd) - 1] = '\0';
  return xQueueSend(eventQueue, &evt, 0) == pdTRUE;
}

// --- HÀM XỬ LÝ KEYPAD ---
void processKey(char key) {
  Serial.print("Key Processed: "); Serial.println(key); 

  if (cameraEnabled) {
      if (key != 'C' && key != 'D') {
          lcdPrint("VUI LONG TAT CAM!", ""); 
          vTaskDelay(1000 / portTICK_PERIOD_MS); displayDefault(); return;
      }
  } else {
      if (key == 'D') {
          lcdPrint("VUI LONG BAT CAM!", ""); 
          vTaskDelay(1000 / portTICK_PERIOD_MS); displayDefault(); return;
      }
  }

  if (key == '*') { 
    inputBuffer[0] = '\0'; currentState = STATE_IDLE; tempNewPassword[0] = '\0'; displayDefault();
  } 
  else if (key == 'A') { currentState = STATE_AUTH_OLD_PASS; inputBuffer[0] = '\0'; displayDefault(); } 
  else if (key == 'B') processCommand("CAM_ON");
  else if (key == 'C') processCommand("CAM_OFF");
  else if (key == 'D') { lcdPrint("Face ID: TODO", ""); vTaskDelay(1000 / portTICK_PERIOD_MS); displayDefault(); } 
  else if (key == '#') { 
    switch(currentState) {
      case STATE_IDLE: 
        if (strcmp(inputBuffer, currentPassword) == 0) {
          wrongPasswordCount = 0; openDoor();
        } else {
          wrongPasswordCount++;
          if (wrongPasswordCount >= 3) {
            lcdPrint("BAO DONG-DA KHOA", "Vui long doi 10s");
            currentState = STATE_LOCKED_OUT; lockoutStartTime = millis();
          } else {
            lcdPrint("SAI MAT KHAU!", ""); vTaskDelay(2000 / portTICK_PERIOD_MS);
            inputBuffer[0] = '\0'; displayDefault();
          }
        } break;
      case STATE_AUTH_OLD_PASS: 
        if (strcmp(inputBuffer, currentPassword) == 0) {
            wrongPasswordCount = 0; currentState = STATE_ENTER_NEW_PASS; inputBuffer[0] = '\0'; displayDefault();
        } else {
            wrongPasswordCount++;
            if (wrongPasswordCount >= 3) {
                lcdPrint("BAO DONG-DA KHOA", "Vui long doi 10s");
                currentState = STATE_LOCKED_OUT; lockoutStartTime = millis();
            } else {
                lcdPrint("SAI PASS CU!", ""); vTaskDelay(2000 / portTICK_PERIOD_MS);
                inputBuffer[0] = '\0'; currentState = STATE_IDLE; displayDefault(); 
            }
        } break;
      case STATE_ENTER_NEW_PASS: 
        if (strlen(inputBuffer) >= 4) {
          strncpy(tempNewPassword, inputBuffer, sizeof(tempNewPassword) - 1);
          tempNewPassword[sizeof(tempNewPassword) - 1] = '\0';
          currentState = STATE_CONFIRM_NEW_PASS; inputBuffer[0] = '\0'; displayDefault();
        } else {
          lcdPrint("PASS NGAN QUA!", ""); vTaskDelay(1500 / portTICK_PERIOD_MS);
          inputBuffer[0] = '\0'; displayDefault(); 
        } break;
      case STATE_CONFIRM_NEW_PASS: 
        if (strcmp(inputBuffer, tempNewPassword) == 0) {
          strncpy(currentPassword, inputBuffer, sizeof(currentPassword) - 1);
          currentPassword[sizeof(currentPassword) - 1] = '\0'; 
          lcdPrint("DOI PASS OK!", ""); vTaskDelay(2000 / portTICK_PERIOD_MS);
          inputBuffer[0] = '\0'; currentState = STATE_IDLE; displayDefault();
        } else {
          lcdPrint("PASS KO KHOP!", ""); vTaskDelay(2000 / portTICK_PERIOD_MS);
          inputBuffer[0] = '\0'; currentState = STATE_IDLE; displayDefault(); 
        } break;
    }
  } else { 
    size_t len = strlen(inputBuffer);
    if (len < 10) { inputBuffer[len] = key; inputBuffer[len+1] = '\0'; displayDefault(); }
  }
}

// --- TASK: KEYPAD POLLING (Đã khắc phục lỗi Deadlock I2C) ---
void keypadTask(void *pvParameters) {
  static char taskLastKey = '\0';
  while(1) {
    char keyToProcess = '\0';

    // BƯỚC 1: Lấy Mutex, đọc phím thật nhanh rồi NHẢ MUTEX NGAY LẬP TỨC
    if (xSemaphoreTake(i2cMutex, portMAX_DELAY) == pdTRUE) {
       if (keypad.isPressed()) {
          char key = keypad.getChar(); 
          if (key != 'N' && key != ' ' && key != '\0') {
             keyToProcess = key;
          }
       }
       xSemaphoreGive(i2cMutex); // Chìa khóa I2C đã được trả lại an toàn!
    }

    // BƯỚC 2: Xử lý sự kiện gửi Queue khi KHÔNG còn giữ Mutex
    if (keyToProcess != '\0') {
       if (keyToProcess != taskLastKey) {
           SystemEvent evt;
           evt.source = SRC_KEYPAD;
           evt.key = keyToProcess;
           evt.cmd[0] = '\0';
           xQueueSend(eventQueue, &evt, 0); // Non-blocking send
           taskLastKey = keyToProcess;
       }
    } else {
       taskLastKey = '\0';
    }
    
    vTaskDelay(50 / portTICK_PERIOD_MS);
  }
}

// --- TASK: LOCAL API SERVER (Thay thế Firebase) ---
void apiTask(void *pvParameters) {
  apiServer.on("/action", HTTP_GET, []() {
    apiServer.sendHeader("Access-Control-Allow-Origin", "*");
    if (apiServer.hasArg("cmd")) {
      String cmd = apiServer.arg("cmd");
      enqueueRemoteCommand(cmd.c_str());
      apiServer.send(200, "text/plain", "OK");
    } else {
      apiServer.send(400, "text/plain", "Missing cmd");
    }
  });

  apiServer.begin();
  Serial.println("Local API Server started on port 8080");

  while(1) {
    apiServer.handleClient();
    vTaskDelay(10 / portTICK_PERIOD_MS);
  }
}

// --- TASK LOGIC CHÍNH ---
void systemControlTask(void *pvParameters) {
  SystemEvent evt;
  while(1) {
      if (xQueueReceive(eventQueue, &evt, 10 / portTICK_PERIOD_MS) == pdTRUE) {
        if (evt.source == SRC_KEYPAD) processKey(evt.key);
        else if (evt.source == SRC_LOCAL_API) processCommand(evt.cmd);
      }

      if (WiFi.status() != WL_CONNECTED) {
        WiFi.disconnect(); WiFi.reconnect(); vTaskDelay(500 / portTICK_PERIOD_MS); continue;
      }

      if (currentState == STATE_LOCKED_OUT) {
        unsigned long lockedDuration = millis() - lockoutStartTime;
        if (lockedDuration < 5000) digitalWrite(BUZZER_PIN, HIGH);
        else digitalWrite(BUZZER_PIN, LOW);

        if (lockedDuration >= 10000) { 
          currentState = STATE_IDLE; wrongPasswordCount = 0; inputBuffer[0] = '\0';
          digitalWrite(BUZZER_PIN, LOW); displayDefault(); Serial.println("Unlock System.");
        }
      }

      if (isDoorOpen && (millis() - doorOpenMillis > 5000)) closeDoor();
      vTaskDelay(10 / portTICK_PERIOD_MS);
  }
}

// --- MAIN SETUP ---
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0); 
  Serial.begin(115200);
  
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  i2cMutex = xSemaphoreCreateMutex();
  Wire.begin(I2C_SDA, I2C_SCL);

  Wire.setTimeOut(20);
  lcd.init(); lcd.backlight(); lcd.print("Dang khoi dong...");
  
  if (keypad.begin()) { Serial.println("Keypad found!"); keypad.loadKeyMap(keyMap); } 
  else { Serial.println("Keypad NOT found!"); lcd.setCursor(0,1); lcd.print("Err: Keypad"); delay(2000); }
  
  myServo.attach(SERVO_PIN); myServo.write(0); 

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0; config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM; config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM; config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM; config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM; config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 10000000; 
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_LATEST;
  
  if(psramFound()){
    // PSRAM cho phep khung hinh lon hon va chat luong JPEG tot hon ma van giu duoc do tre thap.
    config.frame_size = FRAMESIZE_QVGA; 
    config.jpeg_quality = 20; 
    config.fb_count = 2; 
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size = FRAMESIZE_QVGA; 
    config.jpeg_quality = 25; 
    config.fb_count = 1; 
    config.fb_location = CAMERA_FB_IN_DRAM;
  }

  if (esp_camera_init(&config) != ESP_OK) { lcd.clear(); lcd.print("Cam Init FAIL!"); delay(2000); } 
  else {
    sensor_t *s = esp_camera_sensor_get();
    if (s) {
      // Preset uu tien stream net va on dinh cho xem local qua LAN.
      s->set_quality(s, 20);
      s->set_contrast(s, 1);
      s->set_brightness(s, 1);
      s->set_saturation(s, 1);
      s->set_ae_level(s, 0);
    }
    lcd.clear(); lcd.print("Cam Init OK!"); delay(1000);
  }
  
  WiFi.begin(ssid, password);
  lcd.clear(); lcd.print("Ket noi WiFi...");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  
  Serial.println("\nWiFi connected!");
  esp_wifi_set_ps(WIFI_PS_NONE);
  lcd.clear(); lcd.print("IP:"); lcd.print(WiFi.localIP()); delay(2000);

  if (MDNS.begin("smartlockcam")) {
    Serial.println("mDNS ready: http://smartlockcam.local");
  } else {
    Serial.println("mDNS start failed");
  }
  
  startCameraServer();
  
  eventQueue = xQueueCreate(10, sizeof(SystemEvent));
  
  xTaskCreatePinnedToCore(keypadTask, "KeypadTask", 2048, NULL, 2, NULL, 1); 
  xTaskCreatePinnedToCore(systemControlTask, "ControlTask", 8192, NULL, 3, NULL, 1);
  xTaskCreatePinnedToCore(apiTask, "ApiTask", 4096, NULL, 1, NULL, 1); // Khởi động Local Web API
  
  displayDefault(); 
  vTaskDelete(NULL); 
}

void loop() { vTaskDelay(1000 / portTICK_PERIOD_MS); }