#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ===========================
// CẤU HÌNH WIFI & FIREBASE
// ===========================
const char* ssid = "Q";
const char* password = "1709200004";

// Link Database (Nhớ có dấu / ở cuối)
String DATABASE_URL = "https://smartlockfreertos-default-rtdb.asia-southeast1.firebasedatabase.app/"; 
// API Key (Lấy trong Project Settings)
String API_KEY = "HtDZEQwj8sOOq4KCTxgQy4RI7ZUXhifkWXgQsToF"; 

#define CAMERA_MODEL_AI_THINKER
#include "camera_pins.h"

// Hàm này nằm trong file app_httpd.cpp (bạn cần file này trong thư mục)
void startCameraServer();

// Biến trạng thái camera
bool cameraEnabled = false;
WiFiClientSecure* streamClient = nullptr;
HTTPClient* streamHttp = nullptr;
bool streamConnected = false;

// --- HÀM GỬI IP LÊN FIREBASE (Dùng REST API siêu nhẹ) ---
void updateFirebaseIP(String ip) {
  WiFiClientSecure* client = new WiFiClientSecure();
  if (!client) {
    Serial.println("Không đủ bộ nhớ để tạo client");
    return;
  }
  
  client->setInsecure(); // Bỏ qua check SSL để tiết kiệm RAM tối đa
  client->setTimeout(10); // Timeout 10 giây
  
  HTTPClient http;
  http.setTimeout(10000); // 10 giây timeout

  // Đường dẫn: /cam_ip.json
  String url = DATABASE_URL + "cam_ip.json?auth=" + API_KEY;
  
  if (http.begin(*client, url)) {
    http.addHeader("Content-Type", "application/json");
    // Gửi IP dạng chuỗi JSON: "http://192.168.1.X:81/stream"
    String data = "\"" + ip + "\""; 
    
    int httpResponseCode = http.PUT(data);
    
    if (httpResponseCode > 0) {
      Serial.println("Đã cập nhật IP lên Firebase: " + ip);
    } else {
      Serial.print("Lỗi gửi Firebase: ");
      Serial.println(httpResponseCode);
    }
    http.end();
  } else {
    Serial.println("Không kết nối được Firebase");
  }
  
  delete client; // Giải phóng bộ nhớ
}

// --- HÀM XÓA LỆNH TRONG FIREBASE ---
void clearCommand() {
  WiFiClientSecure* client = new WiFiClientSecure();
  if (!client) return;
  
  client->setInsecure();
  client->setTimeout(5);
  
  HTTPClient http;
  http.setTimeout(5000);
  
  String url = DATABASE_URL + "command/action.json?auth=" + API_KEY;
  
  if (http.begin(*client, url)) {
    http.addHeader("Content-Type", "application/json");
    int httpResponseCode = http.PUT("null"); // Xóa lệnh bằng cách set null
    
    if (httpResponseCode > 0) {
      Serial.println("Đã xóa lệnh cũ trong Firebase");
    }
    http.end();
  }
  
  delete client;
}

// --- HÀM KẾT NỐI FIREBASE STREAMING (Lắng nghe real-time) ---
void connectFirebaseStream() {
  if (streamClient) {
    streamClient->stop();
    delete streamClient;
  }
  if (streamHttp) {
    delete streamHttp;
  }
  
  streamClient = new WiFiClientSecure();
  streamClient->setInsecure();
  streamHttp = new HTTPClient();
  
  // URL streaming với tham số auth
  String url = DATABASE_URL + "command/action.json?auth=" + API_KEY;
  
  if (streamHttp->begin(*streamClient, url)) {
    streamHttp->addHeader("Accept", "text/event-stream");
    streamHttp->addHeader("Cache-Control", "no-cache");
    
    int httpCode = streamHttp->GET();
    
    if (httpCode == HTTP_CODE_OK) {
      Serial.println("Đã kết nối Firebase Stream");
      streamConnected = true;
    } else {
      Serial.printf("Lỗi kết nối stream: %d\n", httpCode);
      streamConnected = false;
    }
  } else {
    Serial.println("Không thể kết nối stream");
    streamConnected = false;
  }
}

// --- HÀM ĐỌC DỮ LIỆU TỪ STREAM ---
void readFirebaseStream() {
  if (!streamConnected || !streamClient || !streamClient->connected()) {
    Serial.println("⚠️ Mất kết nối stream, đang kết nối lại...");
    connectFirebaseStream();
    return;
  }
  
  // Đọc dữ liệu có sẵn
  while (streamClient->available()) {
    String line = streamClient->readStringUntil('\n');
    
    // Firebase SSE format: "data: {"path":"/","data":"CAM_ON"}"
    if (line.startsWith("data:")) {
      Serial.println("Event nhận được: " + line);
      
      // Parse command từ JSON
      int dataStart = line.indexOf("\"data\":\"");
      if (dataStart > 0) {
        dataStart += 8; // Độ dài của "data":"
        int dataEnd = line.indexOf("\"", dataStart);
        if (dataEnd > dataStart) {
          String cmd = line.substring(dataStart, dataEnd);
          processCommand(cmd);
        }
      }
      // Xử lý trường hợp data là null
      else if (line.indexOf("\"data\":null") > 0) {
        Serial.println(" Dữ liệu null, bỏ qua");
      }
    }
  }
}

// --- HÀM XỬ LÝ LỆNH ---
void processCommand(String cmd) {
  if (cmd == "CAM_ON" && !cameraEnabled) {
    Serial.println(" Bật camera...");
    cameraEnabled = true;
    
    // Tạm dừng stream để tránh conflict
    if (streamClient) {
      streamClient->stop();
      streamConnected = false;
    }
    
    String streamUrl = "http://" + WiFi.localIP().toString() + ":81/stream";
    updateFirebaseIP(streamUrl);
    delay(500); // Đợi Firebase cập nhật
    clearCommand(); // Xóa lệnh sau khi xử lý
    
    // Kết nối lại stream sau 1 giây
    delay(1000);
    connectFirebaseStream();
  } 
  else if (cmd == "CAM_OFF" && cameraEnabled) {
    Serial.println(" Tắt camera...");
    cameraEnabled = false;
    
    // Tạm dừng stream để tránh conflict
    if (streamClient) {
      streamClient->stop();
      streamConnected = false;
    }
    
    updateFirebaseIP("OFF");
    delay(500); // Đợi Firebase cập nhật
    clearCommand(); // Xóa lệnh sau khi xử lý
    
    // Kết nối lại stream sau 1 giây
    delay(1000);
    connectFirebaseStream();
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);

  // 1. Cấu hình Camera
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  
  // --- CHỈNH SỬA QUAN TRỌNG Ở ĐÂY ---
  config.pixel_format = PIXFORMAT_JPEG;
  
  // Chọn độ phân giải thấp để chạy mượt
  // Các lựa chọn: FRAMESIZE_QVGA (320x240 - Siêu mượt), FRAMESIZE_VGA (640x480 - Vừa phải)
  config.frame_size = FRAMESIZE_QVGA; 

  // Chọn chất lượng ảnh (0-63). Số càng to càng giảm chất lượng & tăng tốc độ.
  // Mức 10-12: Rất nét (Nặng)
  // Mức 30-40: Vừa phải (Khuyên dùng)
  // Mức 60: Rất mờ (Siêu nhẹ)
  config.jpeg_quality = 15; 
  
  config.fb_count = 1;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

  // Tinh chỉnh nếu có PSRAM (Giúp buffer tốt hơn nhưng vẫn giữ setting thấp)
  if(config.pixel_format == PIXFORMAT_JPEG){
    if(psramFound()){
      config.jpeg_quality = 30; // PSRAM hỗ trợ thì cho nét hơn xíu (30)
      config.fb_count = 2;      // Dùng 2 buffer để video không bị giật
      config.grab_mode = CAMERA_GRAB_LATEST;
    } else {
      // Nếu không có PSRAM, bắt buộc phải giảm tải tối đa
      config.frame_size = FRAMESIZE_QQVGA; // 160x120
      config.fb_location = CAMERA_FB_IN_DRAM;
    }
  }

  // Khởi tạo Camera
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    return;
  }

  // Tùy chỉnh cảm biến để màu đẹp hơn dù độ phân giải thấp
  sensor_t * s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1); 
    s->set_brightness(s, 1); 
    s->set_saturation(s, -2); 
  }
  // // Lật hình nếu bị ngược (tùy loại cam)
  // s->set_vflip(s, 1); 
  // s->set_hmirror(s, 1);

  // 2. Kết nối Wifi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");

  // 3. Khởi động Stream Server (Cổng 80 và 81)
  startCameraServer();

  // 4. Đặt trạng thái ban đầu là OFF
  Serial.println(" Camera ban đầu ở chế độ TẮT");
  updateFirebaseIP("OFF");
  
  Serial.println(" Hệ thống sẵn sàng. IP: " + WiFi.localIP().toString());
  Serial.println("Stream URL: http://" + WiFi.localIP().toString() + ":81/stream");
  
  // 5. Kết nối Firebase Streaming để lắng nghe lệnh real-time
  Serial.println("🔗 Đang kết nối Firebase Stream...");
  connectFirebaseStream();
}

void loop() {
  // Kiểm tra WiFi
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(" Mất kết nối WiFi, đang kết nối lại...");
    WiFi.reconnect();
    delay(5000);
    return;
  }

  // Đọc dữ liệu từ Firebase Stream (Real-time, không tốn tài nguyên)
  readFirebaseStream();
  
  // Delay nhẹ để giảm tải CPU
  delay(10);
}