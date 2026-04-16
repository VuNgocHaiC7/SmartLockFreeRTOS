DROP DATABASE IF EXISTS ESP32KEY;
CREATE DATABASE ESP32KEY;
USE ESP32KEY;


CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  secret VARCHAR(128) NOT NULL,
  ip VARCHAR(64),
  is_active TINYINT(1) DEFAULT 1,
  last_seen TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS access_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  recognized_name VARCHAR(120) NULL, 
  confidence DECIMAL(5,2) NULL,
  result ENUM('ALLOW','DENY','ENROLLED','UNKNOWN') DEFAULT 'ALLOW',
  status VARCHAR(20) NULL,
  image_url VARCHAR(255) NULL,
  photo_url VARCHAR(255) NULL,
  note VARCHAR(255) NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  source ENUM('esp32_auto','web_manual','unknown') DEFAULT 'unknown',
  
  -- Khóa ngoại liên kết với bảng devices
  CONSTRAINT fk_log_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,

  -- Tạo index
  INDEX(device_id), 
  INDEX(status), 
  INDEX(recognized_name), 
  INDEX(timestamp), 
  INDEX(source)
);


CREATE TABLE IF NOT EXISTS api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(120),
  api_key VARCHAR(128) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL
);


CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash CHAR(64) NOT NULL,
  role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP NULL,
  INDEX(role),
  INDEX(is_active)
);


INSERT INTO devices (id, name, secret) VALUES
('DOOR-01', 'Cửa chính', 'DEV_SECRET_123');

INSERT INTO api_keys (label, api_key) VALUES
('AdminKey', 'ADMIN_API_KEY_123');


INSERT INTO users (username, password_hash, role, is_active) VALUES
('admin', SHA2('123', 256), 'admin', 1),
('user', SHA2('123', 256), 'user', 1);


CREATE OR REPLACE VIEW v_access_logs_detail AS
SELECT 
    al.id,
    al.device_id,
    d.name as device_name,
    al.recognized_name,
    al.confidence,
    al.status,
    al.result,
    al.photo_url,
    al.image_url,
    al.timestamp,
    al.source,
    al.note
FROM access_logs al
LEFT JOIN devices d ON al.device_id = d.id
ORDER BY al.id DESC;