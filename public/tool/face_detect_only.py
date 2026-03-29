"""
Ultra-fast face detection using OpenCV Haar Cascade
Optimized for real-time tracking: <50ms per frame
"""
import argparse, json, time
import cv2
import numpy as np

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True)
    args = ap.parse_args()

    t0 = time.time()
    
    # Load Haar Cascade classifier (cực nhanh!)
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)
    
    # Load ảnh với OpenCV (nhanh hơn PIL)
    img = cv2.imread(args.image)
    if img is None:
        print(json.dumps({'ok': False, 'error': 'Cannot read image', 'faces': []}))
        return
    
    # Convert sang grayscale (Haar Cascade chỉ cần grayscale)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Resize xuống 1/2 để tăng tốc (vẫn giữ độ chính xác cao)
    height, width = gray.shape
    scale = 2
    gray_small = cv2.resize(gray, (width // scale, height // scale), interpolation=cv2.INTER_LINEAR)
    
    # Detect faces với Haar Cascade - CỰC NHANH!
    # scaleFactor: 1.1 = chính xác hơn nhưng chậm hơn, 1.3 = nhanh hơn
    # minNeighbors: 3 = phát hiện nhiều hơn (có thể false positive), 5 = chính xác hơn
    # minSize: kích thước mặt tối thiểu (tránh phát hiện mặt quá nhỏ)
    faces = face_cascade.detectMultiScale(
        gray_small,
        scaleFactor=1.2,      # Cân bằng tốc độ/độ chính xác
        minNeighbors=4,       # Giảm false positive
        minSize=(20, 20),     # Mặt tối thiểu 40x40 pixels trên ảnh gốc
        flags=cv2.CASCADE_SCALE_IMAGE
    )
    
    # Convert sang format chuẩn và scale lên
    faces_out = []
    for (x, y, w, h) in faces:
        # Scale tọa độ lên kích thước gốc
        x1, y1 = x * scale, y * scale
        x2, y2 = (x + w) * scale, (y + h) * scale
        
        faces_out.append({
            'box': [int(x1), int(y1), int(x2), int(y2)],
            'name': 'tracking',
            'matched': False
        })
    
    latency = int((time.time() - t0) * 1000)
    
    out = {
        'ok': True,
        'faces': faces_out,
        'latency_ms': latency,
        'count': len(faces_out)
    }
    print(json.dumps(out))

if __name__ == '__main__':
    main()
