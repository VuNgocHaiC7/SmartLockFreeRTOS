#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include "esp_http_server.h"
#include <UniversalTelegramBot.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Keypad.h>

// ==============================================================================
// 1. CẤU HÌNH PINOUT
// ==============================================================================
#define WIFI_SSID "TP-Link_F6D2"
#define WIFI_PASSWORD "1223334444"
#define BOT_TOKEN "8232539691:AAFjxKp9UVyrpdwC03NzUR4DwNcSEnQsE10"
#define CHAT_ID "7624836973"

#define IR_SENSOR_PIN  42  // Chân OUT của cảm biến LM393
#define SERVO_PIN      14 
#define BUZZER_PIN     21
#define I2C_SDA        33  // ✅ Đổi từ 4 để tránh xung đột với camera SIOD
#define I2C_SCL        34  // ✅ Đổi từ 5 để tránh xung đột với camera SIOC  

// --- KEYPAD CONFIG ---
const byte ROWS = 4;
const byte COLS = 4;
char keys[ROWS][COLS] = {
  {'1','2','3','A'}, 
  {'4','5','6','B'}, 
  {'7','8','9','C'}, 
  {'*','0','#','D'}
};
byte rowPins[ROWS] = {35, 36, 37, 39};  // ✅ Dùng GPIO an toàn hơn
byte colPins[COLS] = {40, 41, 1, 2};    // ✅ Tránh GPIO 46 (strapping pin) 

// --- CAMERA PINOUT (ESP32-S3 Cam) ---
#define XCLK_GPIO_NUM  15
#define SIOD_GPIO_NUM  4
#define SIOC_GPIO_NUM  5
#define Y9_GPIO_NUM    16
#define Y8_GPIO_NUM    17
#define Y7_GPIO_NUM    18
#define Y6_GPIO_NUM    12
#define Y5_GPIO_NUM    10
#define Y4_GPIO_NUM    8
#define Y3_GPIO_NUM    9
#define Y2_GPIO_NUM    11
#define VSYNC_GPIO_NUM 6
#define HREF_GPIO_NUM  7
#define PCLK_GPIO_NUM  13

// ==============================================================================
// 2. BIẾN TOÀN CỤC & RTOS
// ==============================================================================
LiquidCrystal_I2C lcd(0x27, 16, 2);
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
Servo myServo;
WiFiClientSecure client;
UniversalTelegramBot bot(BOT_TOKEN, client);

QueueHandle_t xQueueKey;
QueueHandle_t xQueueDisplay;
QueueHandle_t xQueueTelegram;
SemaphoreHandle_t xMutexI2C;

String currentPass = "1234";
bool wifiConnected = false;
struct DisplayMsg { String line1; String line2; bool clear; };
struct TelegramMsg { String type; String data; };

// Phụ trợ
void sendToDisplay(String l1, String l2, bool clr = true) {
  DisplayMsg msg = {l1, l2, clr};
  xQueueSend(xQueueDisplay, &msg, 0);
}

void sendTelegramNotification(String type, String data = "") {
  if (!wifiConnected || xQueueTelegram == NULL) return;
  TelegramMsg msg = {type, data};
  xQueueSend(xQueueTelegram, &msg, 0);
}

// ==============================================================================
// 3. CÁC TASK
// ==============================================================================

// --- TASK: CẢM BIẾN HỒNG NGOẠI (LM393) ---
void Task_Proximity(void *pvParameters) {
  pinMode(IR_SENSOR_PIN, INPUT);
  bool personDetected = false;

  while (1) {
    // LM393 thường trả về LOW khi có vật cản (tùy module)
    if (digitalRead(IR_SENSOR_PIN) == LOW) { 
      if (!personDetected) {
        personDetected = true;
        Serial.println("IR: Person Detected! Starting Face Recognition...");
        sendToDisplay("Hello!", "Scanning Face...");
        
        // Gửi thông báo + ảnh qua Telegram
        sendTelegramNotification("person_detected", "");
        
        // CHỖ NÀY SẼ CHÈN LOGIC NHẬN DIỆN KHUÔN MẶT SAU
        // Ví dụ: runFaceRecognition();
        
        vTaskDelay(5000 / portTICK_PERIOD_MS); // Chờ 5s mới quét lại
      }
    } else {
      personDetected = false;
    }
    vTaskDelay(100 / portTICK_PERIOD_MS);
  }
}

void Task_Display(void *pvParameters) {
  DisplayMsg msg;
  while (1) {
    if (xQueueReceive(xQueueDisplay, &msg, portMAX_DELAY)) {
      if (xSemaphoreTake(xMutexI2C, portMAX_DELAY)) {
        if (msg.clear) lcd.clear();
        lcd.setCursor(0, 0); lcd.print(msg.line1);
        lcd.setCursor(0, 1); lcd.print(msg.line2);
        xSemaphoreGive(xMutexI2C);
      }
    }
  }
}

void Task_Keypad(void *pvParameters) {
  while (1) {
    char key = keypad.getKey();
    if (key) {
      xQueueSend(xQueueKey, &key, 10);
      digitalWrite(BUZZER_PIN, HIGH); vTaskDelay(50 / portTICK_PERIOD_MS); digitalWrite(BUZZER_PIN, LOW);
    }
    vTaskDelay(30 / portTICK_PERIOD_MS);
  }
}

void Task_Controller(void *pvParameters) {
  char key;
  String inputBuffer = "";
  sendToDisplay("Smart Lock S3", "Enter Password:");

  while (1) {
    if (xQueueReceive(xQueueKey, &key, portMAX_DELAY)) {
      if (key == '#') {
        if (inputBuffer == currentPass) {
          sendToDisplay("Access Granted", "Welcome!");
          sendTelegramNotification("access_granted", "Door unlocked by keypad");
          myServo.write(90);
          vTaskDelay(5000 / portTICK_PERIOD_MS);
          myServo.write(0);
          sendToDisplay("Smart Lock S3", "Enter Password:");
        } else {
          sendToDisplay("Wrong Password", "Try Again");
          sendTelegramNotification("wrong_password", "Failed attempt: " + inputBuffer);
          vTaskDelay(2000 / portTICK_PERIOD_MS);
          sendToDisplay("Smart Lock S3", "Enter Password:");
        }
        inputBuffer = "";
      } else if (key == '*') {
        inputBuffer = "";
        sendToDisplay("Cleared", "");
      } else {
        inputBuffer += key;
        String mask = "";
        for(int i=0; i<inputBuffer.length(); i++) mask += "*";
        sendToDisplay("Inputting:", mask);
      }
    }
  }
}

// --- TASK: TELEGRAM BOT ---
void Task_Telegram(void *pvParameters) {
  TelegramMsg msg;
  unsigned long lastCheck = 0;
  const unsigned long checkInterval = 1000; // Kiểm tra tin nhắn mỗi 1s

  while (1) {
    // Kiểm tra WiFi
    if (WiFi.status() != WL_CONNECTED) {
      wifiConnected = false;
      vTaskDelay(5000 / portTICK_PERIOD_MS);
      continue;
    }
    wifiConnected = true;

    // Xử lý thông báo từ Queue
    while (xQueueReceive(xQueueTelegram, &msg, 0)) {
      if (msg.type == "access_granted") {
        bot.sendMessage(CHAT_ID, "✅ " + msg.data, "");
      } else if (msg.type == "wrong_password") {
        bot.sendMessage(CHAT_ID, "⚠️ " + msg.data, "");
      } else if (msg.type == "person_detected") {
        bot.sendMessage(CHAT_ID, "🚶 Someone detected at door!", "");
        // Gửi ảnh
        camera_fb_t *fb = esp_camera_fb_get();
        if (fb) {
          bot.sendPhotoByBinary(CHAT_ID, "image/jpeg", fb->len, 
                                fb->buf, fb->len);
          esp_camera_fb_return(fb);
        }
      }
    }

    // Kiểm tra tin nhắn mới từ Telegram
    if (millis() - lastCheck > checkInterval) {
      lastCheck = millis();
      int numNewMessages = bot.getUpdates(bot.last_message_received + 1);
      
      for (int i = 0; i < numNewMessages; i++) {
        String chat_id = String(bot.messages[i].chat_id);
        String text = bot.messages[i].text;
        
        if (chat_id != CHAT_ID) continue; // Chỉ nhận từ chat_id đã đặt
        
        if (text == "/start") {
          bot.sendMessage(chat_id, "🔐 Smart Lock ESP32-S3\n"
                                   "/status - Check status\n"
                                   "/unlock - Unlock door\n"
                                   "/photo - Take photo\n"
                                   "/changepass NEW - Change password", "");
        } 
        else if (text == "/status") {
          String status = "📊 System Status:\n";
          status += "WiFi: ✅ Connected\n";
          status += "Camera: ✅ Ready\n";
          status += "Lock: 🔒 Locked";
          bot.sendMessage(chat_id, status, "");
        }
        else if (text == "/unlock") {
          bot.sendMessage(chat_id, "🔓 Unlocking door...", "");
          sendToDisplay("Remote Unlock", "Telegram");
          myServo.write(90);
          vTaskDelay(5000 / portTICK_PERIOD_MS);
          myServo.write(0);
          bot.sendMessage(chat_id, "✅ Door unlocked and relocked!", "");
          sendToDisplay("Smart Lock S3", "Enter Password:");
        }
        else if (text == "/photo") {
          camera_fb_t *fb = esp_camera_fb_get();
          if (fb) {
            bot.sendPhotoByBinary(chat_id, "image/jpeg", fb->len, 
                                  fb->buf, fb->len);
            esp_camera_fb_return(fb);
            bot.sendMessage(chat_id, "📸 Photo captured!", "");
          } else {
            bot.sendMessage(chat_id, "❌ Camera error!", "");
          }
        }
        else if (text.startsWith("/changepass ")) {
          String newPass = text.substring(12);
          if (newPass.length() >= 4 && newPass.length() <= 8) {
            currentPass = newPass;
            bot.sendMessage(chat_id, "✅ Password changed successfully!", "");
            sendToDisplay("Pass Changed", "Via Telegram");
            vTaskDelay(2000 / portTICK_PERIOD_MS);
            sendToDisplay("Smart Lock S3", "Enter Password:");
          } else {
            bot.sendMessage(chat_id, "❌ Password must be 4-8 characters!", "");
          }
        }
        else {
          bot.sendMessage(chat_id, "❓ Unknown command. Try /start", "");
        }
      }
    }
    
    vTaskDelay(100 / portTICK_PERIOD_MS);
  }
}

// ==============================================================================
// 4. SETUP
// ==============================================================================
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  myServo.attach(SERVO_PIN, 500, 2400);
  myServo.write(0);

  Wire.begin(I2C_SDA, I2C_SCL);
  lcd.init();
  lcd.backlight();

  // ✅ Tạo Queue/Semaphore và kiểm tra lỗi
  xQueueKey = xQueueCreate(10, sizeof(char));
  xQueueDisplay = xQueueCreate(5, sizeof(DisplayMsg));
  xQueueTelegram = xQueueCreate(10, sizeof(TelegramMsg));
  xMutexI2C = xSemaphoreCreateMutex();
  
  if (xQueueKey == NULL || xQueueDisplay == NULL || xQueueTelegram == NULL || xMutexI2C == NULL) {
    Serial.println("Failed to create Queue/Semaphore!");
    while(1) { vTaskDelay(1000 / portTICK_PERIOD_MS); }
  }

  // Khởi tạo Camera
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM; config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = -1; config.pin_reset = -1;
  config.xclk_freq_hz = 20000000; config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA; config.jpeg_quality = 12; config.fb_count = 1;
  
  // ✅ Kiểm tra lỗi camera
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    lcd.setCursor(0, 0); lcd.print("Camera Error!");
    while(1) { vTaskDelay(1000 / portTICK_PERIOD_MS); }
  }
  Serial.println("Camera initialized successfully!");

  // ✅ Kết nối WiFi và đợi
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int wifi_retry = 0;
  while (WiFi.status() != WL_CONNECTED && wifi_retry < 20) {
    delay(500);
    Serial.print(".");
    wifi_retry++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("IP: "); Serial.println(WiFi.localIP());
    wifiConnected = true;
  } else {
    Serial.println("\nWiFi Failed! Continuing without WiFi...");
    wifiConnected = false;
  }
  client.setInsecure();

  // Khởi tạo các Task
  xTaskCreatePinnedToCore(Task_Display, "LCD", 4096, NULL, 2, NULL, 1);
  xTaskCreatePinnedToCore(Task_Keypad, "KBD", 4096, NULL, 3, NULL, 1);
  xTaskCreatePinnedToCore(Task_Proximity, "PROX", 4096, NULL, 2, NULL, 1);
  xTaskCreatePinnedToCore(Task_Controller, "CTL", 8192, NULL, 2, NULL, 1);
  xTaskCreatePinnedToCore(Task_Telegram, "TG", 16384, NULL, 1, NULL, 0);

  Serial.println("System Ready with IR Sensor & Telegram Bot!");
}

void loop() { vTaskDelete(NULL); }