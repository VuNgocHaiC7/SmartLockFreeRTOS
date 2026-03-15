#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "I2CKeyPad.h" 
#include <ESP32Servo.h>

// Khai báo hàm từ app_httpd.cpp
extern void startCameraServer();

#define NO_KEY '\0' 

// ===========================
// CẤU HÌNH PIN & ĐỊA CHỈ I2C
// ===========================
#define I2C_SDA 13
#define I2C_SCL 15
#define SERVO_PIN 14
#define LCD_ADDR 0x27      
#define KEYPAD_ADDR 0x20  

// Khởi tạo đối tượng
LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
I2CKeyPad keypad(KEYPAD_ADDR); 
Servo myServo;

// --- CÁC BIẾN QUẢN LÝ TRẠNG THÁI HỆ THỐNG ---
enum SystemState {
  STATE_IDLE,               // Trạng thái chờ mở cửa bình thường
  STATE_AUTH_OLD_PASS,      // Trạng thái yêu cầu nhập pass cũ
  STATE_ENTER_NEW_PASS,     // Trạng thái nhập pass mới
  STATE_CONFIRM_NEW_PASS,   // Trạng thái xác nhận pass mới
  STATE_LOCKED_OUT          // Trạng thái khóa hệ thống tạm thời
};

SystemState currentState = STATE_IDLE; // Trạng thái mặc định
String tempNewPassword = "";           // Biến lưu tạm pass mới để so sánh xác nhận

String currentPassword = "1234"; 
String inputBuffer = "";
unsigned long doorOpenMillis = 0;
bool isDoorOpen = false;
int wrongPasswordCount = 0;            // Biến đếm số lần nhập sai mật khẩu
unsigned long lockoutStartTime = 0;    // Biến lưu thời điểm bắt đầu khóa hệ thống

// Map phím chuẩn 4x4
char keyMap[] = "123A456B789C*0#D"; 
static char lastKey = '\0';

// ===========================
// CẤU HÌNH WIFI & FIREBASE
// ===========================
const char* ssid = "Q";
const char* password = "1709200004";
String DATABASE_URL = "https://smartlockfreertos-default-rtdb.asia-southeast1.firebasedatabase.app/"; 
String API_KEY = "HtDZEQwj8sOOq4KCTxgQy4RI7ZUXhifkWXgQsToF"; 

// ===========================
// CẤU HÌNH CAMERA PIN (AI THINKER)
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

// ===========================
// CẤU HÌNH TELEGRAM BOT
// ===========================
#define BOT_TOKEN "8232539691:AAFjxKp9UVyrpdwC03NzUR4DwNcSEnQsE10"
#define CHAT_ID "7624836973"

bool cameraEnabled = false;
WiFiClientSecure* streamClient = nullptr;
HTTPClient* streamHttp = nullptr;
bool streamConnected = false;

// Khai báo hàm
void updateFirebaseIP(String ip);
void connectFirebaseStream();
void clearCommand();
void sendTelegramMessage(String message);

// --- HÀM GỬI THÔNG BÁO TELEGRAM ---
void sendTelegramMessage(String message) {
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClientSecure client;
    client.setInsecure(); // Bỏ qua xác thực chứng chỉ SSL
    HTTPClient http;
    
    String url = "https://api.telegram.org/bot" + String(BOT_TOKEN) + "/sendMessage";
    http.begin(client, url);
    http.addHeader("Content-Type", "application/json");
    
    // Tạo chuỗi JSON chứa ID người nhận và nội dung tin nhắn
    String payload = "{\"chat_id\":\"" + String(CHAT_ID) + "\", \"text\":\"" + message + "\"}";
    
    int httpResponseCode = http.POST(payload);
    if (httpResponseCode > 0) {
      Serial.printf("Đã gửi Telegram. Mã phản hồi: %d\n", httpResponseCode);
    } else {
      Serial.printf("Lỗi gửi Telegram: %s\n", http.errorToString(httpResponseCode).c_str());
    }
    http.end();
  }
}

// --- HÀM LCD HIỂN THỊ MẶC ĐỊNH ---
void displayDefault() {
  if (currentState == STATE_LOCKED_OUT) return; // Không vẽ lại màn hình nếu đang khóa

  lcd.clear();
  lcd.setCursor(0, 0);
  
  // Hiển thị tiêu đề tùy theo trạng thái
  switch(currentState) {
    case STATE_IDLE: 
      lcd.print("Nhap Password:"); 
      break;
    case STATE_AUTH_OLD_PASS: 
      lcd.print("Nhap Pass Cu:"); 
      break;
    case STATE_ENTER_NEW_PASS: 
      lcd.print("Nhap Pass Moi:"); 
      break;
    case STATE_CONFIRM_NEW_PASS: 
      lcd.print("Xac Nhan Lai:"); 
      break;
    default:
      break;
  }
  
  // Hiển thị các dấu * tương ứng với số ký tự đã nhập
  lcd.setCursor(0, 1);
  lcd.print(">");
  for(int i = 0; i < inputBuffer.length(); i++) {
    lcd.print("*");
  }
}

// --- HÀM ĐIỀU KHIỂN CỬA ---
void openDoor() {
  Serial.println(" Cửa mở!");
  lcd.clear();
  lcd.print("DUNG MAT KHAU!");
  lcd.setCursor(0, 1);
  lcd.print("DANG MO CUA...");
  myServo.write(90); 
  isDoorOpen = true;
  doorOpenMillis = millis();
  
  // 1. Gửi thông báo cửa mở
  sendTelegramMessage("🔓 Thông báo: Cửa đã được mở thành công!");
}

void closeDoor() {
  Serial.println("Cửa đóng!");
  myServo.write(0); 
  isDoorOpen = false;
  inputBuffer = ""; 
  displayDefault();
}

// --- HÀM XỬ LÝ LỆNH TỪ FIREBASE ---
void processCommand(String cmd) {
  cmd.trim(); 
  cmd.replace("\"", ""); 

  Serial.print("Nhận lệnh: "); Serial.println(cmd);

  if (cmd == "UNLOCK") {
    // Nếu hệ thống đang khóa, từ chối lệnh mở cửa từ xa
    if (currentState == STATE_LOCKED_OUT) {
      Serial.println("Hệ thống đang bị khóa, từ chối mở cửa từ xa!");
      clearCommand();
      return;
    }
    openDoor();
    clearCommand();
  }
  else if (cmd == "CAM_ON" && !cameraEnabled) {
    Serial.println(" Bật camera...");
    cameraEnabled = true;
    String streamUrl = "http://" + WiFi.localIP().toString() + ":81/stream";
    updateFirebaseIP(streamUrl);
    delay(500); clearCommand();
    
    if (streamClient) { streamClient->stop(); streamConnected = false; }
    
    lcd.clear(); lcd.print("CAM: ON"); delay(1000); displayDefault();
  } 
  else if (cmd == "CAM_OFF" && cameraEnabled) {
    Serial.println(" Tắt camera...");
    cameraEnabled = false;
    updateFirebaseIP("OFF");
    delay(500); clearCommand();
    
    if (streamClient) { streamClient->stop(); streamConnected = false; }
    
    lcd.clear(); lcd.print("CAM: OFF"); delay(1000); displayDefault();
  }
}

// --- HÀM XỬ LÝ KEYPAD ---
void handleKeypad() {
  // Nếu hệ thống đang bị khóa, KHÔNG nhận bất kỳ phím nào
  if (currentState == STATE_LOCKED_OUT) {
    return;
  }

  if (keypad.isPressed()) {
    char key = keypad.getChar(); 
    
    // Nếu thư viện trả về 'N' (No Key) hoặc lỗi thì bỏ qua
    if (key == 'N' || key == ' ' || key == '\0') return; 

    // CHỈ xử lý khi phím hiện tại KHÁC với phím vừa bấm ở vòng lặp trước
    if (key != lastKey) { 
      Serial.print("Key: "); Serial.println(key); 

      if (key == '*') { 
        // Phím Cancel: Hủy bỏ mọi thao tác, quay về trạng thái mặc định
        inputBuffer = "";
        currentState = STATE_IDLE;
        tempNewPassword = "";
        displayDefault();
      } 
      else if (key == 'A') { 
        // Bắt đầu quy trình đổi mật khẩu
        currentState = STATE_AUTH_OLD_PASS;
        inputBuffer = "";
        displayDefault();
      } 
      else if (key == 'B') processCommand("CAM_ON");
      else if (key == 'C') processCommand("CAM_OFF");
      else if (key == 'D') { 
        lcd.clear(); lcd.print("Face ID: TODO"); delay(1000); displayDefault();
      } 
      else if (key == '#') { 
        // Phím Enter: Xử lý theo từng trạng thái
        switch(currentState) {
          
          case STATE_IDLE: // Đang mở cửa bình thường
            if (inputBuffer == currentPassword) {
              wrongPasswordCount = 0; // Reset số lần nhập sai khi nhập đúng
              openDoor();
            } else {
              wrongPasswordCount++; // Tăng biến đếm nhập sai
              if (wrongPasswordCount >= 3) {
                // Khóa hệ thống
                sendTelegramMessage("⚠️ CẢNH BÁO: Phát hiện nhập sai mật khẩu mở cửa 3 lần liên tiếp! Hệ thống khóa 10 giây.");
                lcd.clear(); lcd.print("KHOA HE THONG!"); lcd.setCursor(0,1); lcd.print("Vui long doi 10s");
                currentState = STATE_LOCKED_OUT;
                lockoutStartTime = millis();
              } else {
                lcd.clear(); lcd.print("SAI MAT KHAU!"); delay(2000);
                inputBuffer = ""; displayDefault();
              }
            }
            break;

          case STATE_AUTH_OLD_PASS: // Bước 1: Nhập pass cũ
            if (inputBuffer == currentPassword) {
              wrongPasswordCount = 0; // Reset biến đếm
              currentState = STATE_ENTER_NEW_PASS; // Đúng pass cũ -> Cho phép nhập pass mới
              inputBuffer = "";
              displayDefault();
            } else {
              wrongPasswordCount++;
              if (wrongPasswordCount >= 3) {
                // Khóa hệ thống
                sendTelegramMessage("⚠️ CẢNH BÁO: Ai đó đang cố gắng đổi mật khẩu và nhập sai 3 lần! Hệ thống khóa 10 giây.");
                lcd.clear(); lcd.print("KHOA HE THONG!"); lcd.setCursor(0,1); lcd.print("Vui long doi 10s");
                currentState = STATE_LOCKED_OUT;
                lockoutStartTime = millis();
              } else {
                lcd.clear(); lcd.print("SAI PASS CU!"); delay(2000);
                inputBuffer = ""; currentState = STATE_IDLE; displayDefault(); // Sai thì thoát ra ngoài
              }
            }
            break;

          case STATE_ENTER_NEW_PASS: // Bước 2: Nhập pass mới
            if (inputBuffer.length() >= 4) {
              tempNewPassword = inputBuffer;         // Lưu tạm pass mới
              currentState = STATE_CONFIRM_NEW_PASS; // Chuyển sang bước xác nhận
              inputBuffer = "";
              displayDefault();
            } else {
              lcd.clear(); lcd.print("PASS NGAN QUA!"); delay(1500);
              inputBuffer = ""; displayDefault(); // Nhập lại pass mới
            }
            break;

          case STATE_CONFIRM_NEW_PASS: // Bước 3: Xác nhận pass mới
            if (inputBuffer == tempNewPassword) {
              currentPassword = inputBuffer; // Cập nhật mật khẩu chính thức
              
              // 3. Gửi thông báo đổi mật khẩu thành công
              sendTelegramMessage("🔄 Thông báo: Mật khẩu hệ thống đã được thay đổi thành công!");
              
              lcd.clear(); lcd.print("DOI PASS OK!"); delay(2000);
              inputBuffer = ""; currentState = STATE_IDLE; displayDefault();
            } else {
              lcd.clear(); lcd.print("PASS KO KHOP!"); delay(2000);
              inputBuffer = ""; currentState = STATE_IDLE; displayDefault(); // Không khớp thì hủy bỏ, làm lại từ đầu
            }
            break;
        }
      } 
      else { 
        // Nhập số (0-9)
        if (inputBuffer.length() < 10) { 
          inputBuffer += key;
          displayDefault(); // Cập nhật lại LCD (đã tích hợp in dấu * ở hàm displayDefault)
        }
      }
      
      // Cập nhật lại trạng thái phím vừa bấm
      lastKey = key; 
    }
  } else {
    // KHI BẠN THẢ TAY RA khỏi bàn phím -> Reset lại biến lastKey
    lastKey = '\0'; 
  }
}

// --- CÁC HÀM FIREBASE ---
void updateFirebaseIP(String ip) {
  WiFiClientSecure* client = new WiFiClientSecure();
  if (!client) return;
  client->setInsecure(); 
  HTTPClient http; 
  String url = DATABASE_URL + "cam_ip.json?auth=" + API_KEY;
  if (http.begin(*client, url)) {
    http.addHeader("Content-Type", "application/json");
    String data = "\"" + ip + "\""; 
    http.PUT(data);
    http.end();
  }
  delete client;
}

void clearCommand() {
  WiFiClientSecure* client = new WiFiClientSecure();
  if (!client) return;
  client->setInsecure();
  HTTPClient http; 
  String url = DATABASE_URL + "command/action.json?auth=" + API_KEY;
  if (http.begin(*client, url)) {
    http.addHeader("Content-Type", "application/json");
    http.PUT("\"\""); 
    http.end();
  }
  delete client;
}

void connectFirebaseStream() {
  if (streamClient) { delete streamClient; streamClient = nullptr; }
  if (streamHttp) { delete streamHttp; streamHttp = nullptr; }
  
  streamClient = new WiFiClientSecure(); 
  streamClient->setInsecure();
  streamHttp = new HTTPClient();
  
  String url = DATABASE_URL + "command/action.json?auth=" + API_KEY;
  
  streamHttp->begin(*streamClient, url);
  streamHttp->addHeader("Accept", "text/event-stream");
  
  int httpCode = streamHttp->GET();
  if (httpCode > 0) {
    Serial.printf("Stream connected: %d\n", httpCode);
    streamConnected = true;
  } else {
    streamConnected = false;
  }
}

void readFirebaseStream() {
  if (!streamConnected || streamClient == nullptr || !streamClient->connected()) {
    connectFirebaseStream();
    return;
  }
  
  while (streamClient->available()) {
    String line = streamClient->readStringUntil('\n');
    if (line.startsWith("data:")) {
      String dataStr = line.substring(5); 
      dataStr.trim();
      if (dataStr == "null") continue; 
      
      int jsonIdx = dataStr.indexOf("\"data\":");
      if (jsonIdx > 0) {
        int startQ = dataStr.indexOf("\"", jsonIdx + 7);
        int endQ = dataStr.indexOf("\"", startQ + 1);
        if (startQ > 0 && endQ > startQ) {
           processCommand(dataStr.substring(startQ + 1, endQ));
        }
      } else {
         processCommand(dataStr); 
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  
  Wire.begin(I2C_SDA, I2C_SCL);

  lcd.init();
  lcd.backlight();
  lcd.print("Dang khoi dong...");
  
  // --- KHỞI TẠO KEYPAD ---
  if (keypad.begin()) {
    Serial.println("Keypad found!");
    keypad.loadKeyMap(keyMap); 
  } else {
    Serial.println("Keypad NOT found!");
    lcd.setCursor(0,1); lcd.print("Err: Keypad");
    delay(2000);
  }
  
  myServo.attach(SERVO_PIN);
  myServo.write(0); 

  // --- Cấu hình Camera ---
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  
  // Cấu hình chất lượng stream thấp để tiết kiệm băng thông
  if(psramFound()){
    config.frame_size = FRAMESIZE_QVGA;  // 320x240 - stream nhẹ
    config.jpeg_quality = 25;             // Chất lượng thấp (0-63, cao = thấp)
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_QVGA;  // 320x240
    config.jpeg_quality = 30;
    config.fb_count = 1;
  }

  // Khởi tạo camera và kiểm tra kết quả
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init FAILED: 0x%x\n", err);
    lcd.clear();
    lcd.print("Cam Init FAIL!");
    delay(2000);
  } else {
    Serial.println("Camera init SUCCESS!");
    lcd.clear();
    lcd.print("Cam Init OK!");
    delay(1000);
  }
  
  WiFi.begin(ssid, password);
  lcd.clear(); lcd.print("Ket noi WiFi...");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  
  // Hiển thị IP của camera
  Serial.println("\nWiFi connected!");
  Serial.print("Camera IP address: ");
  Serial.println(WiFi.localIP());
  Serial.print("Camera Stream URL: http://");
  Serial.print(WiFi.localIP());
  Serial.println(":81/stream");
  
  lcd.clear();
  lcd.print("IP:");
  lcd.print(WiFi.localIP());
  delay(2000);
  
  // Khởi động Camera HTTP Server
  Serial.println("Starting camera server...");
  startCameraServer();
  Serial.println("Camera server started!");
  
  updateFirebaseIP("OFF");
  connectFirebaseStream();
  
  displayDefault(); 

  // 4. Gửi thông báo hệ thống đã khởi động xong (Gửi cuối cùng sau khi có mạng)
  sendTelegramMessage("✅ Hệ thống Khóa Thông Minh đã khởi động và sẵn sàng hoạt động!");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect();
    WiFi.reconnect();
    delay(500); 
    return;
  }

  // --- KIỂM TRA MỞ KHÓA HỆ THỐNG (SAU 10 GIÂY) ---
  if (currentState == STATE_LOCKED_OUT) {
    if (millis() - lockoutStartTime >= 10000) { 
      // Đã qua 10 giây -> Mở khóa hệ thống, reset số lần nhập sai
      currentState = STATE_IDLE;
      wrongPasswordCount = 0;
      inputBuffer = "";
      displayDefault();
      Serial.println("Hệ thống đã mở khóa trở lại.");
    }
  }

  handleKeypad();
  readFirebaseStream();

  if (isDoorOpen && (millis() - doorOpenMillis > 5000)) {
    closeDoor();
  }

  delay(10); 
}