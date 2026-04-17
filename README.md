# SmartLockFreeRTOS

He thong khoa cua thong minh su dung ESP32-CAM + FreeRTOS + Flask + Web Dashboard + nhan dien khuon mat.

## 1) Tong quan he thong

He thong gom 3 phan chinh:

- Firmware ESP32-CAM (FreeRTOS): quan ly keypad, servo, LCD, camera, buzzer, va giao tiep voi backend.
- Backend Flask (Python): xu ly API, nhan dien khuon mat, luu log, quan ly user va danh sach khuon mat.
- Frontend Web (PHP + JS + CSS): giao dien dang nhap, xem stream, mo khoa, Face ID, thong ke, quan tri.

Luong hoat dong co ban:

1. ESP32 chup anh khi nguoi dung bam phim D hoac khi web yeu cau.
2. ESP32 gui anh JPEG ve Flask endpoint /api/face-unlock.
3. Flask chay script nhan dien khuon mat trong public/tool/face_check.py.
4. Neu match thanh cong thi mo khoa, luu log truy cap, cap nhat dashboard.

## 2) Cau truc thu muc

- app.py: Flask backend chinh (port 5000).
- config/env.py: cau hinh DB, upload, ESP32 IP, duong dan Python.
- src/: module DB, auth, helpers.
- database.sql: schema MySQL + du lieu mau.
- public/: giao dien web + uploads + cong cu nhan dien.
- CameraESP32/: firmware ESP32-CAM (Arduino).

## 3) Yeu cau he thong

### Backend va Web

- Windows (khuyen nghi dung Laragon)
- Python 3.11
- MySQL/MariaDB
- Apache (neu chay web qua Laragon)

### Python packages can co

- flask
- flask-cors
- requests
- pillow
- mysql-connector-python
- opencv-python
- face_recognition
- numpy<2.0
- dlib (co san file wheel trong public/tool)

### ESP32

- Board ESP32-CAM (AI Thinker pin map trong code)
- LCD I2C 16x2
- I2C Keypad
- Servo
- Buzzer
- Arduino IDE + ESP32 core

## 4) Cai dat backend Flask

Thuc hien tai thu muc goc du an SmartLockFreeRTOS.

### Buoc 1: Tao moi truong Python

Windows CMD:

```bat
python -m venv .venv
.venv\Scripts\activate
```

### Buoc 2: Cai thu vien

Cach de on dinh tren Windows:

```bat
pip install --upgrade pip
pip install public\tool\dlib-19.24.1-cp311-cp311-win_amd64.whl
pip install -r public\tool\requirements.txt
pip install flask flask-cors requests pillow mysql-connector-python
```

Neu da cai dlib bang cach khac, co the bo qua dong cai file wheel.

### Buoc 3: Tao database

Nhap file SQL:

```bat
mysql -u root -p < database.sql
```

Du lieu mac dinh sau khi import:

- Database: ESP32KEY
- Device mac dinh: DOOR-01 / DEV_SECRET_123
- API key mau: ADMIN_API_KEY_123
- Web users:
  - admin / 123
  - user / 123

### Buoc 4: Kiem tra cau hinh

Mo file config/env.py va dieu chinh:

- DB host, port, user, password
- APP_CONFIG.esp32_ip
- APP_CONFIG.python_bin (duong dan Python tren may ban)
- APP_CONFIG.faces_db_dir neu doi thu muc kho khuon mat
- APP_CONFIG.tolerance va min_face_confidence

### Buoc 5: Chay backend

```bat
python app.py
```

Backend se chay tai:

- http://127.0.0.1:5000

## 5) Cai dat va chay Web Dashboard

Web UI nam trong thu muc public.

Co 2 cach chay:

### Cach A: Qua Laragon Apache (khuyen nghi)

- Dat du an trong www cua Laragon.
- Truy cap theo duong dan:
  - http://127.0.0.1/SmartLockFreeRTOS/public/
- File .htaccess da cau hinh rewrite vao index.php va proxy API ve Flask.

### Cach B: Goi truc tiep Flask API

Frontend JS co co che fallback goi:

- /api/...
- http://127.0.0.1:5000/api/...
- http://localhost:5000/api/...

Chi can dam bao Flask dang chay port 5000.

## 6) Nap firmware ESP32-CAM

Mo CameraESP32/CameraESP32.ino trong Arduino IDE.

### Can sua truoc khi nap

1. WiFi:

- const char\* ssid = "...";
- const char\* password = "...";

2. URL backend face unlock:

- FACE_UNLOCK_URL phai tro den IP may chay Flask, KHONG phai IP cua ESP32.
- Mau dung:
  - http://<IP_MAY_TINH>:5000/api/face-unlock?source=keypad_d&device_id=DOOR-01

3. Telegram (neu dung):

- BOT_TOKEN
- CHAT_ID

### Sau khi nap

- Mo Serial Monitor 115200.
- Xac nhan ESP32 vao WiFi thanh cong.
- Xac nhan co stream camera va local API port 8080.

## 7) Huong dan su dung cho nguoi dung

## 7.1 Dang nhap web

- Truy cap trang web dashboard.
- Dang nhap bang tai khoan:
  - admin / 123
  - user / 123

## 7.2 Chuc nang theo vai tro

User:

- Xem stream camera
- Bat/tat camera
- Mo khoa
- Face ID
- Xem lich su va thong ke

Admin (ngoai cac quyen cua user):

- Them khuon mat tu camera
- Quan ly danh sach khuon mat
- Xoa toan bo logs
- Tao/sua/khoa/xoa tai khoan

## 7.3 Nhan phim tren keypad

- Nhap ma + #: mo cua bang mat khau
- A: vao che do doi mat khau
- B: bat camera
- C: tat camera
- D: xac thuc khuon mat
- \*: xoa input va quay ve trang thai cho

Ghi chu:

- Mat khau mac dinh tren thiet bi la 1234.
- Nhap sai 3 lan se khoa tam thoi (bao dong).

## 7.4 Them khuon mat

1. Dang nhap bang admin.
2. Bat camera.
3. Nhap ten nguoi can them.
4. Bam Them Tu Camera.
5. He thong chup anh tu ESP32 va luu vao public/tool/faces_db/<ten>/.

Khuyen nghi:

- Moi nguoi nen co nhieu anh, goc mat va anh sang khac nhau de tang do chinh xac.

## 8) API chinh

Auth va User:

- POST /api/auth/login
- GET /api/admin/users
- POST /api/admin/users
- PUT /api/admin/users/<id>/role
- PUT /api/admin/users/<id>/status
- DELETE /api/admin/users/<id>

Camera va Face:

- GET /api/esp32/capture
- GET /api/esp32-capture
- GET /api/face-check
- POST /api/face-check
- GET /api/face-detect-fast
- POST /api/face-unlock
- POST /api/add-face

Door va Logs:

- POST /api/door/unlock
- GET /api/door/status
- GET /api/access-log
- POST /api/access-log
- GET/POST/DELETE /api/logs

Quan ly kho khuon mat:

- GET /api/faces
- GET /api/face-photo/<name>
- PUT /api/faces/<name>
- DELETE /api/faces/<name>
- GET /api/faces/<name>/images
- POST /api/faces/<name>/images
- GET /api/faces/<name>/images/<filename>
- DELETE /api/faces/<name>/images/<filename>

## 9) Thu muc du lieu quan trong

- public/uploads/YYYYMMDD/: anh chup va unlock logs.
- public/tool/faces_db/: kho anh khuon mat de train/match.
- public/activity_fallback.jsonl: log fallback neu DB loi.
- public/tool/faces_db/.encodings_cache_v2.pkl: cache encoding de tang toc nhan dien.

## 10) Xu ly loi thuong gap

### 1) Bam phim D nhung LCD bao loi ket noi API

Nguyen nhan pho bien:

- FACE_UNLOCK_URL dang tro sai host (tro vao IP ESP32 thay vi IP may chay Flask).

Cach sua:

- Dat FACE_UNLOCK_URL = http://IP_MAY_CHAY_FLASK:5000/api/face-unlock?...
- Dam bao may tinh va ESP32 cung mang LAN.
- Thu ping qua lai neu can.

### 2) Face recognition qua cham lan dau

- Lan dau he thong rebuild cache khuon mat nen cham hon.
- Cac lan sau se nhanh hon nho file .encodings_cache_v2.pkl.

### 3) Loi import dlib/face_recognition tren Windows

- Cai dlib wheel co san trong public/tool truoc.
- Dung dung Python 3.11.

### 4) Dang nhap web that bai

- Kiem tra DB da import database.sql chua.
- Kiem tra bang users co admin/user mac dinh.
- Kiem tra Flask dang chay port 5000.

### 5) Khong co anh stream

- Kiem tra ESP32 da bat camera chua (phim B).
- Kiem tra endpoint stream cua ESP32 port 81.
- Kiem tra JS dang tro den IP ESP32 dung.

## 11) Luu y bao mat

- Khong de thong tin that (WiFi password, BOT_TOKEN, CHAT_ID) trong source khi deploy cong khai.
- Doi ngay mat khau user mac dinh admin/user sau khi cai dat.
- Doi API key va device secret trong database.sql truoc khi dua vao san pham that.
- Co the dat reverse proxy + HTTPS neu trien khai qua Internet.

## 12) Lenh khoi dong nhanh (tom tat)

```bat
cd c:\laragon\www\SmartLockFreeRTOS
.venv\Scripts\activate
python app.py
```

Sau do mo dashboard:

- http://127.0.0.1/SmartLockFreeRTOS/public/

---
