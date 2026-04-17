"""
Main Flask application for Project_Q - Python Backend
"""
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import os
import sys
import time
import json
import secrets
import subprocess
import tempfile
import requests
from PIL import Image
import io
import hashlib
import binascii
from functools import wraps

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))
from src.db import execute_query, Database
from src.helpers import (json_response, error_response, success_response,
                         require_fields, ensure_upload_dir, validate_ip)
from src.auth import require_api_key, require_device_auth
from config.env import APP_CONFIG

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

_fallback_log_file = os.path.join(os.path.dirname(__file__), 'public', 'activity_fallback.jsonl')
_web_sessions = {}
_session_ttl_seconds = 12 * 60 * 60


# ==================== UTILITY FUNCTIONS ====================

def get_esp_ip():
    """Get ESP32 IP from request or config"""
    ip = request.args.get('ip', request.json.get('ip') if request.is_json else None)
    if not ip:
        ip = APP_CONFIG['esp32_ip']
    return ip.strip()

def fetch_esp32_image(ip, timeout=6):
    """Fetch image from ESP32 camera"""
    session = requests.Session()
    try:
        for path in APP_CONFIG['snapshot_paths']:
            url = f"http://{ip}{path}"
            try:
                response = session.get(url, timeout=timeout)
                if response.status_code == 200 and response.content.startswith(b'\xff\xd8'):
                    content = response.content
                    response.close()
                    return content
                response.close()
            except:
                continue
    finally:
        session.close()
    return None

def calculate_image_diff(img1_bytes, img2_bytes):
    """
    Calculate percentage difference between two images
    Returns percentage (0-100)
    """
    try:
        # Open images
        img1 = Image.open(io.BytesIO(img1_bytes))
        img2 = Image.open(io.BytesIO(img2_bytes))
        
        # Resize to standard size for comparison
        size = (96, 72)
        img1 = img1.resize(size).convert('L')  # Grayscale
        img2 = img2.resize(size).convert('L')
        
        # Calculate pixel differences
        pixels1 = list(img1.getdata())
        pixels2 = list(img2.getdata())
        
        total_diff = sum(abs(p1 - p2) for p1, p2 in zip(pixels1, pixels2))
        max_diff = len(pixels1) * 255
        
        return (total_diff / max_diff) * 100
    except Exception as e:
        print(f"Image diff error: {e}")
        return 100.0

def build_log_record(device_id='DOOR-01', status='unknown', photo_url=None,
                     recognized_name=None, confidence=0, source='unknown'):
    """Build unified log object used by DB and fallback file."""
    return {
        'device_id': device_id,
        'status': status,
        'photo_url': photo_url,
        'recognized_name': recognized_name,
        'confidence': float(confidence or 0),
        'source': source,
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S')
    }

def append_fallback_log(record):
    """Append one activity record to local fallback jsonl file."""
    try:
        os.makedirs(os.path.dirname(_fallback_log_file), exist_ok=True)
        with open(_fallback_log_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
    except Exception as e:
        print(f"[WARN] Cannot write fallback log: {e}")

def read_fallback_logs(limit=50):
    """Read latest activity records from local fallback file."""
    if not os.path.exists(_fallback_log_file):
        return []

    try:
        with open(_fallback_log_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        records = []
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except Exception:
                continue
            if len(records) >= limit:
                break
        return records
    except Exception as e:
        print(f"[WARN] Cannot read fallback logs: {e}")
        return []

def clear_fallback_logs():
    """Delete fallback log file if it exists."""
    try:
        if os.path.exists(_fallback_log_file):
            os.unlink(_fallback_log_file)
    except Exception as e:
        print(f"[WARN] Cannot clear fallback logs: {e}")

def _serialize_log_rows(rows):
    """Convert DB datetime objects to stable local strings for frontend."""
    if not isinstance(rows, list):
        return rows

    serialized = []
    for row in rows:
        item = dict(row)
        for key in ('timestamp', 'ts', 'created_at', 'last_seen'):
            value = item.get(key)
            if hasattr(value, 'strftime'):
                item[key] = value.strftime('%Y-%m-%d %H:%M:%S')
        serialized.append(item)
    return serialized

def _serialize_user_rows(rows):
    """Convert DB datetime objects in users rows to stable strings."""
    if not isinstance(rows, list):
        return rows

    serialized = []
    for row in rows:
        item = dict(row)
        for key in ('created_at', 'last_login'):
            value = item.get(key)
            if hasattr(value, 'strftime'):
                item[key] = value.strftime('%Y-%m-%d %H:%M:%S')
        serialized.append(item)
    return serialized

def _hash_password(raw_password):
    """Hash password using SHA-256 for web login."""
    return hashlib.sha256(str(raw_password or '').encode('utf-8')).hexdigest()

def _extract_bearer_token():
    """Read Bearer token from Authorization header."""
    auth_header = request.headers.get('Authorization', '').strip()
    if not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:].strip()
    return token or None

def _get_current_web_user():
    """Resolve current logged-in user from session token."""
    token = _extract_bearer_token()
    if not token:
        return None

    session = _web_sessions.get(token)
    if not session:
        return None

    expires_at = session.get('expires_at', 0)
    if time.time() > expires_at:
        _web_sessions.pop(token, None)
        return None

    return session.get('user')

def require_web_auth(f):
    """Decorator to require valid web login token."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user = _get_current_web_user()
        if not user:
            return error_response('Unauthorized. Please login.', 401)
        request.current_user = user
        return f(*args, **kwargs)
    return decorated_function

def require_role(*allowed_roles):
    """Decorator to require specific role(s) for web user."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            user = _get_current_web_user()
            if not user:
                return error_response('Unauthorized. Please login.', 401)

            role = str(user.get('role', 'user')).lower()
            if role not in allowed_roles:
                return error_response('Forbidden. Insufficient permissions.', 403)

            request.current_user = user
            return f(*args, **kwargs)
        return decorated_function
    return decorator

# ==================== API ROUTES ====================

@app.route('/api/auth/login', methods=['POST'])
def web_login():
    """Web login endpoint (username/password) with role response."""
    try:
        data = request.get_json() or request.form.to_dict()
        username = str(data.get('username', '')).strip()
        password = str(data.get('password', '')).strip()

        if not username or not password:
            return error_response('Missing username or password', 400)

        user_row = execute_query(
            '''SELECT id, username, role, is_active, password_hash
               FROM users
               WHERE username = %s
               LIMIT 1''',
            (username,),
            fetch_one=True
        )

        if not user_row:
            return error_response('Invalid username or password', 401)

        if int(user_row.get('is_active') or 0) != 1:
            return error_response('Account is disabled', 403)

        expected_hash = user_row.get('password_hash')
        if expected_hash != _hash_password(password):
            return error_response('Invalid username or password', 401)

        execute_query(
            'UPDATE users SET last_login = NOW() WHERE id = %s',
            (user_row['id'],)
        )

        token = secrets.token_hex(32)
        expires_at = time.time() + _session_ttl_seconds
        _web_sessions[token] = {
            'user': {
                'id': user_row['id'],
                'username': user_row['username'],
                'role': user_row['role'],
            },
            'expires_at': expires_at,
        }

        return success_response({
            'token': token,
            'expires_in': _session_ttl_seconds,
            'user': {
                'id': user_row['id'],
                'username': user_row['username'],
                'role': user_row['role'],
            }
        })
    except Exception as e:
        return error_response(f'Login error: {str(e)}', 500)

@app.route('/api/admin/users', methods=['GET'])
@require_role('admin')
def admin_get_users():
    """Admin endpoint to list all web login users."""
    users = execute_query(
        '''SELECT id, username, role, is_active, created_at, last_login
           FROM users
           ORDER BY id DESC''',
        fetch_all=True
    )
    return success_response({'users': _serialize_user_rows(users)})

@app.route('/api/admin/users', methods=['POST'])
@require_role('admin')
def admin_create_user():
    """Admin endpoint to create a new web login user."""
    try:
        data = request.get_json() or request.form.to_dict()
        username = str(data.get('username', '')).strip()
        raw_password = str(data.get('password', '')).strip()
        role = str(data.get('role', 'user')).strip().lower() or 'user'

        if not username or not raw_password:
            return error_response('Username and password are required', 400)

        if len(username) < 3 or len(username) > 64:
            return error_response('Username must be 3-64 characters', 400)

        if len(raw_password) < 3:
            return error_response('Password must be at least 3 characters', 400)

        import re
        if not re.match(r'^[a-zA-Z0-9_.-]+$', username):
            return error_response('Username can only contain letters, numbers, dot, underscore, hyphen', 400)

        if role not in ('admin', 'user'):
            return error_response('Role must be admin or user', 400)

        exists = execute_query(
            'SELECT id FROM users WHERE username = %s LIMIT 1',
            (username,),
            fetch_one=True
        )
        if exists:
            return error_response('Username already exists', 409)

        execute_query(
            '''INSERT INTO users (username, password_hash, role, is_active)
               VALUES (%s, %s, %s, 1)''',
            (username, _hash_password(raw_password), role)
        )

        return success_response({'message': 'User created successfully'})
    except Exception as e:
        return error_response(f'Create user error: {str(e)}', 500)

@app.route('/api/admin/users/<int:user_id>/role', methods=['PUT'])
@require_role('admin')
def admin_update_user_role(user_id):
    """Admin endpoint to change a user's role."""
    data = request.get_json() or request.form.to_dict()
    role = str(data.get('role', '')).strip().lower()

    if role not in ('admin', 'user'):
        return error_response('Role must be admin or user', 400)

    current_user = getattr(request, 'current_user', {}) or {}
    if int(current_user.get('id') or 0) == int(user_id):
        return error_response('Cannot change your own role', 400)

    target = execute_query(
        'SELECT id FROM users WHERE id = %s LIMIT 1',
        (user_id,),
        fetch_one=True
    )
    if not target:
        return error_response('User not found', 404)

    execute_query(
        'UPDATE users SET role = %s WHERE id = %s',
        (role, user_id)
    )
    return success_response({'message': 'Role updated'})

@app.route('/api/admin/users/<int:user_id>/status', methods=['PUT'])
@require_role('admin')
def admin_update_user_status(user_id):
    """Admin endpoint to lock/unlock a user account."""
    data = request.get_json() or request.form.to_dict()
    is_active = data.get('is_active')

    if str(is_active) not in ('0', '1'):
        return error_response('is_active must be 0 or 1', 400)

    is_active = int(is_active)
    current_user = getattr(request, 'current_user', {}) or {}
    if int(current_user.get('id') or 0) == int(user_id) and is_active == 0:
        return error_response('Cannot deactivate your own account', 400)

    target = execute_query(
        'SELECT id FROM users WHERE id = %s LIMIT 1',
        (user_id,),
        fetch_one=True
    )
    if not target:
        return error_response('User not found', 404)

    execute_query(
        'UPDATE users SET is_active = %s WHERE id = %s',
        (is_active, user_id)
    )
    return success_response({'message': 'Status updated'})

@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@require_role('admin')
def admin_delete_user(user_id):
    """Admin endpoint to delete a user account."""
    current_user = getattr(request, 'current_user', {}) or {}
    if int(current_user.get('id') or 0) == int(user_id):
        return error_response('Cannot delete your own account', 400)

    target = execute_query(
        'SELECT id FROM users WHERE id = %s LIMIT 1',
        (user_id,),
        fetch_one=True
    )
    if not target:
        return error_response('User not found', 404)

    execute_query('DELETE FROM users WHERE id = %s', (user_id,))
    return success_response({'message': 'User deleted'})

@app.route('/api/devices', methods=['GET'])
@require_api_key
def get_devices():
    """Get all devices"""
    devices = execute_query(
        'SELECT id, name, ip, is_active, last_seen, created_at FROM devices ORDER BY id',
        fetch_all=True
    )
    return json_response({'data': devices})

@app.route('/api/device/heartbeat', methods=['POST'])
def device_heartbeat():
    """Device heartbeat endpoint"""
    data = request.get_json() or request.form.to_dict()
    
    device_id = data.get('deviceId')
    token = data.get('token')
    
    if not device_id or not token:
        return error_response('Missing deviceId or token', 422)
    
    # Verify device
    device = execute_query(
        'SELECT * FROM devices WHERE id = %s AND secret = %s AND is_active = 1',
        (device_id, token),
        fetch_one=True
    )
    
    if not device:
        return error_response('Unauthorized device', 401)
    
    # Update last seen and IP
    ip = data.get('ip', request.remote_addr)
    execute_query(
        'UPDATE devices SET ip = %s, last_seen = NOW() WHERE id = %s',
        (ip, device_id)
    )
    
    return success_response({'ip': ip, 'device': device_id})

@app.route('/api/esp32/capture', methods=['GET'])
def esp32_capture():
    """Capture image from ESP32 and save it"""
    try:
        ip = get_esp_ip()
        
        # Fetch image from ESP32
        img_bytes = fetch_esp32_image(ip, timeout=10)
        if not img_bytes:
            return error_response('Cannot capture image from ESP32', 502)
        
        # Save image
        day, day_path = ensure_upload_dir()
        timestamp = int(time.time())
        random_hex = binascii.hexlify(os.urandom(4)).decode()
        filename = f"{timestamp}_{random_hex}.jpg"
        
        filepath = os.path.join(day_path, filename)
        with open(filepath, 'wb') as f:
            f.write(img_bytes)
        
        # Generate public URL
        base = APP_CONFIG['upload_base'].rstrip('/')
        public_url = f"{base}/{day}/{filename}"
        
        return success_response({'url': public_url})
        
    except Exception as e:
        return error_response(f'Exception: {str(e)}', 500)

@app.route('/api/esp32/ctrl', methods=['GET'])
def esp32_control():
    """Control ESP32 camera settings"""
    ip = request.args.get('ip')
    var = request.args.get('var')
    val = request.args.get('val')
    
    if not ip or not var or val is None:
        return error_response('Missing ip, var, or val', 422)
    
    try:
        url = f"http://{ip}/control?var={var}&val={val}"
        response = requests.get(url, timeout=5)
        
        if response.status_code < 200 or response.status_code >= 300:
            return error_response(f'ESP32 returns HTTP {response.status_code}', 502)
        
        return success_response({'resp': response.text, 'url': url})
        
    except Exception as e:
        return error_response(str(e), 502)

@app.route('/api/esp32/auto-capture', methods=['GET'])
@app.route('/api/esp32/auto_capture', methods=['GET'])
def esp32_auto_capture():
    """
    Auto capture when motion detected
    Parameters:
        - ip: ESP32 IP
        - thr: Threshold percentage (0-100)
        - delay: Delay between captures in ms
        - full: Whether to save full image (0 or 1)
    """
    try:
        ip = get_esp_ip()
        thr = float(request.args.get('thr', 7.5))
        delay = int(request.args.get('delay', 300))
        do_full = int(request.args.get('full', 1)) == 1
        
        # Validate params
        thr = max(0, min(100, thr))
        delay = max(0, delay)
        
        # Capture first image
        img1 = fetch_esp32_image(ip)
        if not img1:
            return error_response('Cannot capture first image', 502)
        
        # Wait
        time.sleep(delay / 1000.0)
        
        # Capture second image
        img2 = fetch_esp32_image(ip)
        if not img2:
            return error_response('Cannot capture second image', 502)
        
        # Calculate difference
        score = round(calculate_image_diff(img1, img2), 2)
        captured = False
        url = None
        
        # If difference exceeds threshold, save image
        if score >= thr and do_full:
            img3 = fetch_esp32_image(ip, timeout=8)
            if img3:
                day, day_path = ensure_upload_dir()
                timestamp = int(time.time())
                random_hex = binascii.hexlify(os.urandom(4)).decode()
                filename = f"{timestamp}_{random_hex}.jpg"
                
                filepath = os.path.join(day_path, filename)
                with open(filepath, 'wb') as f:
                    f.write(img3)
                
                base = APP_CONFIG['upload_base'].rstrip('/')
                url = f"{base}/{day}/{filename}"
                captured = True
        
        return success_response({
            'captured': captured,
            'score': score,
            'url': url,
            'thr': thr,
            'delay': delay
        })
        
    except Exception as e:
        return error_response(f'Server exception: {str(e)}', 500)

@app.route('/api/face-check', methods=['GET', 'POST'])
@app.route('/api/face_check', methods=['GET', 'POST'])
def face_check():
    """
    Face detection and recognition
    Accepts either uploaded image or fetches from ESP32
    """
    try:
        # Get image data
        tmp_file = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
        
        if request.files and 'image' in request.files:
            # From file upload
            file = request.files['image']
            file.save(tmp_file.name)
        else:
            # From ESP32
            ip = get_esp_ip()
            img_bytes = fetch_esp32_image(ip, timeout=6)
            if not img_bytes:
                os.unlink(tmp_file.name)
                return error_response('Cannot capture image from ESP32', 502)
            
            tmp_file.write(img_bytes)
            tmp_file.flush()
        
        tmp_file.close()
        
        # Build Python command
        python_bin = APP_CONFIG['python_bin']
        script_path = os.path.join(APP_CONFIG['tools_dir'], 'face_check.py')
        db_path = APP_CONFIG['faces_db_dir']
        tolerance = APP_CONFIG['tolerance']
        min_face_confidence = APP_CONFIG.get('min_face_confidence', 55.0)
        
        cmd = [
            python_bin,
            script_path,
            '--image', tmp_file.name,
            '--db', db_path,
            '--tolerance', str(tolerance),
            '--min-confidence', str(min_face_confidence)
        ]
        
        # Execute Python script
        print(f"[DEBUG] Running command: {' '.join(cmd)}")
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=APP_CONFIG['python_timeout']
            )
            
            print(f"[DEBUG] Return code: {result.returncode}")
            print(f"[DEBUG] Stdout length: {len(result.stdout)}")
            print(f"[DEBUG] Stderr: {result.stderr[:200] if result.stderr else 'None'}")
            
        except subprocess.TimeoutExpired as e:
            os.unlink(tmp_file.name)
            return error_response(f'Python script timeout after {APP_CONFIG["python_timeout"]}s', 500)
        except Exception as e:
            os.unlink(tmp_file.name)
            return error_response(f'Subprocess error: {str(e)}', 500)
        
        # Clean up temp file
        os.unlink(tmp_file.name)
        
        if result.returncode != 0:
            return error_response(f'Python error ({result.returncode}): {result.stderr}', 500)
        
        # Return Python output as JSON
        return app.response_class(
            response=result.stdout,
            status=200,
            mimetype='application/json'
        )
        
    except Exception as e:
        return error_response(f'Exception: {str(e)}', 500)

@app.route('/api/face-detect-fast', methods=['GET'])
@app.route('/api/face_detect_fast', methods=['GET'])
def face_detect_fast():
    """
    Fast face detection using Haar Cascade (no recognition)
    For real-time tracking
    """
    try:
        ip = get_esp_ip()
        
        # Capture image
        img_bytes = fetch_esp32_image(ip, timeout=6)
        if not img_bytes:
            return error_response('Cannot capture image from ESP32', 502)
        
        # Save to temp file
        tmp_file = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
        tmp_file.write(img_bytes)
        tmp_file.close()
        
        # Run fast detection script
        python_bin = APP_CONFIG['python_bin']
        script_path = os.path.join(APP_CONFIG['tools_dir'], 'face_detect_only.py')
        
        cmd = [python_bin, script_path, '--image', tmp_file.name]
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=5
        )
        
        os.unlink(tmp_file.name)
        
        if result.returncode != 0:
            return error_response(f'Detection error: {result.stderr}', 500)
        
        return app.response_class(
            response=result.stdout,
            status=200,
            mimetype='application/json'
        )
        
    except Exception as e:
        return error_response(f'Exception: {str(e)}', 500)

@app.route('/api/esp32-capture', methods=['GET'])
@app.route('/api/esp32_capture', methods=['GET'])
def esp32_capture_raw():
    """Return raw ESP32 camera image"""
    try:
        ip = get_esp_ip()
        img_bytes = fetch_esp32_image(ip, timeout=6)
        
        if not img_bytes:
            return error_response('Cannot capture image', 502)
        
        return send_file(
            io.BytesIO(img_bytes),
            mimetype='image/jpeg'
        )
        
    except Exception as e:
        return error_response(str(e), 500)

@app.route('/api/draw-overlay', methods=['POST'])
@app.route('/api/draw_overlay', methods=['POST'])
def draw_overlay():
    """
    Draw detection boxes on image
    Expects 'boxes' parameter with JSON data and image in body
    """
    try:
        import json
        from PIL import ImageDraw, ImageFont
        
        # Get boxes data from query param
        boxes_json = request.args.get('boxes')
        if not boxes_json:
            return error_response('Missing boxes parameter', 400)
        
        boxes_data = json.loads(boxes_json)
        faces = boxes_data.get('faces', [])
        
        # Get image from request body
        img_bytes = request.get_data()
        img = Image.open(io.BytesIO(img_bytes))
        draw = ImageDraw.Draw(img)
        
        # Draw boxes and labels
        for face in faces:
            box = face.get('box', [])
            if len(box) != 4:
                continue
            
            x1, y1, x2, y2 = box
            matched = face.get('matched', False)
            name = face.get('name', 'unknown')
            confidence = face.get('confidence', 0)
            
            # Choose color
            color = '#10b981' if matched else '#ef4444'
            
            # Draw rectangle
            draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
            
            # Draw label
            label = f"{'✓' if matched else '✗'} {name}"
            if matched:
                label += f" ({confidence}%)"
            
            # Draw text background
            text_bbox = draw.textbbox((x1, y1 - 25), label)
            draw.rectangle(text_bbox, fill=color)
            draw.text((x1 + 5, y1 - 20), label, fill='white')
        
        # Return modified image
        output = io.BytesIO()
        img.save(output, format='JPEG')
        output.seek(0)
        
        return send_file(output, mimetype='image/jpeg')
        
    except Exception as e:
        return error_response(f'Draw error: {str(e)}', 500)

@app.route('/api/add-face', methods=['POST'])
@app.route('/api/add_face', methods=['POST'])
@require_role('admin')
def add_face():
    """
    Add new face to database
    Expects JSON with 'name' and 'image_url'
    """
    try:
        data = request.get_json()
        if not data:
            return error_response('Missing JSON data', 400)
        
        name = data.get('name', '').strip()
        image_url = data.get('image_url', '').strip()
        
        # Validate inputs
        if not name:
            return error_response('Name is required', 400)
        
        if not image_url:
            return error_response('Image URL is required', 400)
        
        # Validate name (alphanumeric and spaces only)
        import re
        if not re.match(r'^[a-zA-Z0-9\s_-]+$', name):
            return error_response('Name can only contain letters, numbers, spaces, hyphens and underscores', 400)
        
        # Download image from URL
        try:
            from urllib.parse import urlparse

            # Normalize URL path (supports absolute URL and project-relative URL)
            parsed = urlparse(image_url)
            image_path = parsed.path if parsed.scheme else image_url

            upload_base = APP_CONFIG.get('upload_base', '/uploads').rstrip('/')
            local_prefixes = [
                '/uploads',
                '/Project_Q/public/uploads',
                upload_base,
            ]

            relative_path = None
            for prefix in local_prefixes:
                if not prefix:
                    continue
                candidate = prefix.rstrip('/') + '/'
                if image_path.startswith(candidate):
                    relative_path = image_path[len(candidate):]
                    break

            if relative_path:
                local_path = os.path.join(APP_CONFIG['upload_dir'], relative_path)
                if not os.path.exists(local_path):
                    return error_response(f'Image file not found: {local_path}', 404)

                with open(local_path, 'rb') as f:
                    img_bytes = f.read()
            else:
                # Remote URL or other relative URL
                fetch_url = image_url
                if image_url.startswith('/'):
                    fetch_url = request.host_url.rstrip('/') + image_url

                response = requests.get(fetch_url, timeout=10)
                if response.status_code != 200:
                    return error_response('Cannot download image', 502)
                img_bytes = response.content
            
            # Verify it's a valid image
            img = Image.open(io.BytesIO(img_bytes))
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
        except Exception as e:
            return error_response(f'Invalid image: {str(e)}', 400)
        
        # Create person directory in faces_db
        faces_db_dir = APP_CONFIG['faces_db_dir']
        person_dir = os.path.join(faces_db_dir, name)
        
        if not os.path.exists(person_dir):
            os.makedirs(person_dir)
        
        # Generate unique filename
        timestamp = int(time.time())
        random_hex = binascii.hexlify(os.urandom(4)).decode()
        filename = f"{timestamp}_{random_hex}.jpg"
        
        # Save image to person directory
        dest_path = os.path.join(person_dir, filename)
        img.save(dest_path, 'JPEG', quality=95)
        
        # Delete cache to force rebuild
        cache_file = os.path.join(faces_db_dir, '.encodings_cache_v2.pkl')
        if os.path.exists(cache_file):
            os.unlink(cache_file)
            print(f"[INFO] Deleted face encodings cache")
        
        return success_response({
            'message': f'Face added successfully for {name}',
            'name': name,
            'filename': filename,
            'path': dest_path
        })
        
    except Exception as e:
        return error_response(f'Server error: {str(e)}', 500)

@app.route('/api/access-log', methods=['GET'])
def get_logs():
    """Get access logs - Public endpoint for frontend polling"""
    limit = int(request.args.get('limit', 100))
    
    logs = execute_query(
        'SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT %s',
        (limit,),
        fetch_all=True
    )
    
    return json_response({'ok': True, 'data': _serialize_log_rows(logs)})

@app.route('/api/logs', methods=['GET', 'POST', 'DELETE'])
@require_web_auth
def logs_endpoint():
    """Handle both GET (query logs) and POST (create log) - Public endpoint"""
    if request.method == 'GET':
        # GET: Query logs with optional limit
        limit = request.args.get('limit', 50, type=int)
        try:
            logs = execute_query(
                f'SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT {limit}',
                fetch_all=True
            )
            return json_response({'ok': True, 'data': _serialize_log_rows(logs)})
        except Exception as e:
            print(f"[WARN] /api/logs DB error, using fallback file: {e}")
            logs = read_fallback_logs(limit)
            return json_response({'ok': True, 'data': logs, 'fallback': True})

    if request.method == 'DELETE':
        db_cleared = False
        db_error = None
        try:
            execute_query('DELETE FROM access_logs')
            db_cleared = True
        except Exception as e:
            db_error = str(e)
            print(f"[WARN] /api/logs DELETE DB error: {e}")

        clear_fallback_logs()

        if db_cleared:
            return success_response({'message': 'All logs deleted'})
        return success_response({
            'message': 'Fallback logs cleared; database delete failed',
            'fallback': True,
            'db_error': db_error
        })
    
    # POST: Create new log
    data = request.get_json() or request.form.to_dict()
    
    status = data.get('status', 'unknown')
    recognized_name = data.get('recognized_name', 'Unknown')
    confidence = float(data.get('confidence', 0))
    source = data.get('source', 'esp32_auto')
    device_id = data.get('device_id', 'DOOR-01')  # Default to DOOR-01 string
    
    try:
        execute_query(
            '''INSERT INTO access_logs 
               (device_id, status, recognized_name, confidence, source, timestamp) 
               VALUES (%s, %s, %s, %s, %s, NOW())''',
            (device_id, status, recognized_name, confidence, source)
        )
        
        return success_response({'message': 'Log saved', 'status': status})
    except Exception as e:
        append_fallback_log(build_log_record(
            device_id=device_id,
            status=status,
            recognized_name=recognized_name,
            confidence=confidence,
            source=source
        ))
        return success_response({'message': 'Log saved (fallback)', 'status': status, 'fallback': True})

@app.route('/api/add-log', methods=['POST'])
def add_log():
    """Add log entry - Alias for /api/logs POST for frontend compatibility"""
    data = request.get_json() or request.form.to_dict()
    
    status = data.get('status', 'unknown')
    recognized_name = data.get('recognized_name', 'Unknown')
    confidence = float(data.get('confidence', 0))
    source = data.get('source', 'web_manual')
    device_id = data.get('device_id', 'DOOR-01')
    esp32_ip = data.get('esp32_ip')
    
    try:
        execute_query(
            '''INSERT INTO access_logs 
               (device_id, status, recognized_name, confidence, source, timestamp) 
               VALUES (%s, %s, %s, %s, %s, NOW())''',
            (device_id, status, recognized_name, confidence, source)
        )
        
        return success_response({'message': 'Log saved', 'status': status})
    except Exception as e:
        return error_response(f'Failed to save log: {str(e)}', 500)

@app.route('/api/access-log', methods=['POST'])
def create_access_log():
    """Create access log entry - for manual face check from web"""
    data = request.get_json() or request.form.to_dict()
    
    device_id = data.get('device_id', 'DOOR-01')  # Default to DOOR-01 string
    status = data.get('status', 'unknown')
    photo_url = data.get('photo_url')
    recognized_name = data.get('recognized_name')
    confidence = data.get('confidence', 0)
    # Force web_manual for this endpoint (manual checks from web interface)
    source = 'web_manual'
    
    try:
        execute_query(
            '''INSERT INTO access_logs 
               (device_id, status, photo_url, recognized_name, confidence, source, timestamp) 
               VALUES (%s, %s, %s, %s, %s, %s, NOW())''',
            (device_id, status, photo_url, recognized_name, confidence, source)
        )
        return success_response({'message': 'Log created'})
    except Exception as e:
        print(f"[WARN] Cannot save /api/access-log to DB: {e}")
        append_fallback_log(build_log_record(
            device_id=device_id,
            status=status,
            photo_url=photo_url,
            recognized_name=recognized_name,
            confidence=confidence,
            source=source
        ))
        return success_response({'message': 'Log created (fallback)', 'fallback': True})

@app.route('/api/face-unlock', methods=['POST'])
@app.route('/api/face_unlock', methods=['POST'])
def face_unlock_endpoint():
    """
    Face unlock API - Nhận diện khuôn mặt tự động từ ESP32
    Nhận ảnh JPEG từ ESP32 và trả về kết quả nhận diện
    """
    try:
        # Get image from request body (raw JPEG from ESP32)
        img_data = request.get_data()
        
        if not img_data or len(img_data) < 100:
            return error_response('No image data received', 400)
        
        # Check JPEG magic number
        if img_data[:2] != b'\xFF\xD8':
            return error_response('Invalid JPEG data', 400)
        
        # Save to temp file
        tmp_file = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
        tmp_file.write(img_data)
        tmp_file.close()
        
        try:
            # Run face recognition
            python_bin = APP_CONFIG['python_bin']
            script_path = os.path.join(APP_CONFIG['tools_dir'], 'face_check.py')
            
            cmd = [
                python_bin,
                script_path,
                '--image', tmp_file.name,
                '--db', APP_CONFIG['faces_db_dir'],
                '--tolerance', str(APP_CONFIG['tolerance']),
                '--min-confidence', str(APP_CONFIG.get('min_face_confidence', 55.0))
            ]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=APP_CONFIG['python_timeout']
            )
            
            if result.returncode != 0:
                return error_response(f'Recognition error: {result.stderr}', 500)
            
            # Parse result
            import json
            face_result = json.loads(result.stdout)
            
            # Check if face is recognized
            recognized = False
            name = None
            confidence = 0
            
            if face_result.get('ok') and face_result.get('faces'):
                for face in face_result['faces']:
                    if face.get('matched'):
                        recognized = True
                        name = face.get('name', 'Unknown')
                        confidence = face.get('confidence', 0)
                        break
            
            # Save photo if configured
            photo_url = None
            if APP_CONFIG.get('save_unlock_photos', True):
                import shutil
                day, day_path = ensure_upload_dir()
                timestamp = int(time.time())
                random_hex = binascii.hexlify(os.urandom(4)).decode()
                filename = f"unlock_{timestamp}_{random_hex}.jpg"
                
                dest_path = os.path.join(day_path, filename)
                shutil.copy(tmp_file.name, dest_path)
                
                base = APP_CONFIG.get('upload_base', '/uploads').rstrip('/')
                photo_url = f"{base}/{day}/{filename}"
            
            # Log access attempt
            device_id = request.args.get('device_id') or 'DOOR-01'
            status = 'granted' if recognized else 'denied'
            
            source = request.args.get('source', 'esp32_auto').strip().lower() or 'esp32_auto'
            # Backward-compatible mapping for old DB enum (no keypad_d value).
            if source == 'keypad_d':
                source = 'esp32_auto'
            if source not in ('esp32_auto', 'web_manual', 'unknown'):
                source = 'esp32_auto'

            try:
                execute_query(
                    '''INSERT INTO access_logs 
                       (device_id, status, photo_url, recognized_name, confidence, source, timestamp) 
                       VALUES (%s, %s, %s, %s, %s, %s, NOW())''',
                    (device_id, status, photo_url, name, confidence, source)
                )
            except Exception as log_err:
                print(f"[WARN] Cannot save log to access_logs: {log_err}")
                append_fallback_log(build_log_record(
                    device_id=device_id,
                    status=status,
                    photo_url=photo_url,
                    recognized_name=name,
                    confidence=confidence,
                    source=source
                ))
            
            # Return result for ESP32
            return success_response({
                'recognized': recognized,
                'name': name or '',
                'confidence': confidence,
                'faces_detected': len(face_result.get('faces', [])),
                'photo_url': photo_url,
                'timestamp': int(time.time())
            })
            
        finally:
            # Clean up temp file
            if os.path.exists(tmp_file.name):
                os.unlink(tmp_file.name)
                
    except subprocess.TimeoutExpired:
        return error_response('Recognition timeout', 500)
    except Exception as e:
        return error_response(f'Server error: {str(e)}', 500)

# ==================== NEW FEATURES API ====================

@app.route('/api/door/unlock', methods=['POST'])
def emergency_unlock():
    """Emergency door unlock - Mở khóa khẩn cấp không cần nhận diện"""
    try:
        # Get ESP32 IP from request or config
        data = request.get_json() if request.is_json else {}
        ip = data.get('ip') or request.args.get('ip') or APP_CONFIG['esp32_ip']
        
        print(f"[Emergency Unlock] Attempting to unlock door at ESP32: {ip}")
        
        # Send unlock command to ESP32
        url = f"http://{ip}/control?var=unlock&val=1"
        response = requests.get(url, timeout=3)
        
        if response.status_code == 200:
            # KHÔNG ghi log vào database (theo yêu cầu người dùng)
            # execute_query(...) - đã bỏ
            
            print(f"[Emergency Unlock] Door unlocked successfully (no log saved)")
            return success_response({
                'message': 'Door unlocked successfully',
                'method': 'emergency',
                'timestamp': time.time()
            })
        else:
            print(f"[Emergency Unlock] ESP32 returned status: {response.status_code}")
            return error_response('Failed to unlock door', 500)
    except requests.exceptions.Timeout:
        print(f"[Emergency Unlock] Timeout connecting to ESP32")
        return error_response('ESP32 connection timeout', 500)
    except requests.exceptions.ConnectionError:
        print(f"[Emergency Unlock] Cannot connect to ESP32")
        return error_response('Cannot connect to ESP32', 500)
    except Exception as e:
        print(f"[Emergency Unlock] Error: {str(e)}")
        return error_response(f'Unlock error: {str(e)}', 500)

@app.route('/api/door/status', methods=['GET'])
def door_status():
    """Get door status"""
    try:
        # Query last log to determine door status
        log = execute_query(
            '''SELECT status, timestamp FROM access_logs 
               ORDER BY timestamp DESC LIMIT 1''',
            fetch_one=True
        )
        
        if log:
            # If last access was within 5 seconds and granted, door is open
            time_diff = (time.time() - log['timestamp'].timestamp()) if hasattr(log['timestamp'], 'timestamp') else 999
            status = 'open' if (log['status'] == 'granted' and time_diff < 5) else 'closed'
        else:
            status = 'closed'
            
        return success_response({'status': status})
    except Exception as e:
        return error_response(f'Status error: {str(e)}', 500)

@app.route('/api/faces', methods=['GET'])
@require_role('admin')
def get_faces():
    """Get all registered faces"""
    try:
        faces_dir = APP_CONFIG['faces_db_dir']
        faces = []
        
        for person_dir in os.listdir(faces_dir):
            person_path = os.path.join(faces_dir, person_dir)
            if os.path.isdir(person_path):
                # Get first image as thumbnail
                images = [f for f in os.listdir(person_path) if f.endswith(('.jpg', '.png'))]
                photo_url = None
                if images:
                    photo_url = None
                # Get creation date
                stat = os.stat(person_path)
                date = time.strftime('%Y-%m-%d %H:%M', time.localtime(stat.st_ctime))
                
                faces.append({
                    'name': person_dir,
                    'photo_url': photo_url,
                    'date': date,
                    'image_count': len(images)
                })
        
        return success_response({'faces': faces})
    except Exception as e:
        return error_response(f'Load faces error: {str(e)}', 500)

@app.route('/api/face-photo/<name>', methods=['GET'])
def get_face_photo(name):
    """Get face photo thumbnail"""
    try:
        faces_dir = APP_CONFIG['faces_db_dir']
        person_path = os.path.join(faces_dir, name)
        
        if not os.path.exists(person_path):
            return error_response('Face not found', 404)
        
        # Get first image
        images = [f for f in os.listdir(person_path) if f.endswith(('.jpg', '.png'))]
        if not images:
            return error_response('No photo found', 404)
        
        photo_path = os.path.join(person_path, images[0])
        return send_file(photo_path, mimetype='image/jpeg')
    except Exception as e:
        return error_response(f'Photo error: {str(e)}', 500)

@app.route('/api/faces/<name>', methods=['PUT'])
@require_role('admin')
def update_face(name):
    """Update face name"""
    try:
        data = request.get_json()
        new_name = data.get('new_name', '').strip()
        
        if not new_name:
            return error_response('New name required', 400)
        
        faces_dir = APP_CONFIG['faces_db_dir']
        old_path = os.path.join(faces_dir, name)
        new_path = os.path.join(faces_dir, new_name)
        
        if not os.path.exists(old_path):
            return error_response('Face not found', 404)
        
        if os.path.exists(new_path):
            return error_response('Name already exists', 400)
        
        # Rename directory
        os.rename(old_path, new_path)
        
        # Rebuild cache
        try:
            subprocess.run(
                [APP_CONFIG['python_bin'], 'public/tool/rebuild_cache_optimized.py'],
                timeout=30,
                check=False
            )
        except:
            pass
        
        return success_response({'message': 'Face updated successfully'})
    except Exception as e:
        return error_response(f'Update error: {str(e)}', 500)

@app.route('/api/faces/<name>', methods=['DELETE'])
@require_role('admin')
def delete_face(name):
    """Delete face"""
    try:
        faces_dir = APP_CONFIG['faces_db_dir']
        person_path = os.path.join(faces_dir, name)
        
        if not os.path.exists(person_path):
            return error_response('Face not found', 404)
        
        # Delete directory and all images
        import shutil
        shutil.rmtree(person_path)
        
        # === THÊM ĐOẠN NÀY ===
        # Xóa luôn file cache để ép hệ thống nhận diện lại từ đầu
        cache_file = os.path.join(faces_dir, '.encodings_cache_v2.pkl')
        if os.path.exists(cache_file):
            os.unlink(cache_file)
            print(f"[INFO] Deleted old cache file: {cache_file}")
        # =====================

        # Rebuild cache (giữ nguyên hoặc bỏ cũng được vì lần nhận diện sau sẽ tự build)
        try:
            subprocess.run(
                [APP_CONFIG['python_bin'], 'public/tool/rebuild_cache_optimized.py'],
                timeout=30,
                check=False
            )
        except:
            pass
        
        return success_response({'message': 'Face deleted successfully'})
    except Exception as e:
        return error_response(f'Delete error: {str(e)}', 500)

@app.route('/api/faces/<name>/images', methods=['GET'])
@require_role('admin')
def get_face_images(name):
    """Get all images for a face"""
    try:
        faces_dir = APP_CONFIG['faces_db_dir']
        person_path = os.path.join(faces_dir, name)
        
        if not os.path.exists(person_path):
            return error_response('Face not found', 404)
        
        images = []
        for filename in os.listdir(person_path):
            if filename.endswith(('.jpg', '.png', '.jpeg')):
                images.append({
                    'filename': filename,
                    'url': f'/api/faces/{name}/images/{filename}'
                })
        
        return success_response({'images': images, 'count': len(images)})
    except Exception as e:
        return error_response(f'Get images error: {str(e)}', 500)

@app.route('/api/faces/<name>/images/<filename>', methods=['GET'])
def get_face_image(name, filename):
    """Get specific image for a face"""
    try:
        faces_dir = APP_CONFIG['faces_db_dir']
        image_path = os.path.join(faces_dir, name, filename)
        
        if not os.path.exists(image_path):
            return error_response('Image not found', 404)
        
        return send_file(image_path, mimetype='image/jpeg')
    except Exception as e:
        return error_response(f'Get image error: {str(e)}', 500)

@app.route('/api/faces/<name>/images/<filename>', methods=['DELETE'])
@require_role('admin')
def delete_face_image(name, filename):
    """Delete specific image for a face"""
    try:
        faces_dir = APP_CONFIG['faces_db_dir']
        person_path = os.path.join(faces_dir, name)
        image_path = os.path.join(person_path, filename)
        
        if not os.path.exists(person_path):
            return error_response('Face not found', 404)
        
        if not os.path.exists(image_path):
            return error_response('Image not found', 404)
        
        # Count remaining images
        images = [f for f in os.listdir(person_path) if f.endswith(('.jpg', '.png', '.jpeg'))]
        
        if len(images) <= 1:
            return error_response('Cannot delete last image. At least one image is required.', 400)
        
        # Delete the image
        os.remove(image_path)
        
        # Rebuild cache
        try:
            subprocess.run(
                [APP_CONFIG['python_bin'], 'public/tool/rebuild_cache_optimized.py'],
                timeout=30,
                check=False
            )
        except:
            pass
        
        return success_response({'message': 'Image deleted successfully'})
    except Exception as e:
        return error_response(f'Delete image error: {str(e)}', 500)

@app.route('/api/faces/<name>/images', methods=['POST'])
@require_role('admin')
def upload_face_images(name):
    """Upload new images for a face"""
    try:
        faces_dir = APP_CONFIG['faces_db_dir']
        person_path = os.path.join(faces_dir, name)
        
        if not os.path.exists(person_path):
            return error_response('Face not found', 404)
        
        if 'images' not in request.files:
            return error_response('No images provided', 400)
        
        files = request.files.getlist('images')
        if not files:
            return error_response('No images selected', 400)
        
        uploaded_count = 0
        for file in files:
            if file and file.filename:
                # Generate unique filename
                ext = os.path.splitext(file.filename)[1]
                if ext.lower() not in ['.jpg', '.jpeg', '.png']:
                    continue
                
                # Create unique filename with timestamp
                timestamp = int(time.time() * 1000)
                new_filename = f"{name}_{timestamp}_{uploaded_count}{ext}"
                filepath = os.path.join(person_path, new_filename)
                
                # Save file
                file.save(filepath)
                uploaded_count += 1
        
        if uploaded_count == 0:
            return error_response('No valid images uploaded', 400)
        
        # Rebuild cache
        try:
            subprocess.run(
                [APP_CONFIG['python_bin'], 'public/tool/rebuild_cache_optimized.py'],
                timeout=30,
                check=False
            )
        except:
            pass
        
        return success_response({
            'message': f'{uploaded_count} images uploaded successfully',
            'count': uploaded_count
        })
    except Exception as e:
        return error_response(f'Upload error: {str(e)}', 500)

# ==================== MAIN ====================

if __name__ == '__main__':
    print("🚀 Starting Project_Q Python Backend...")
    print(f"📁 Upload dir: {APP_CONFIG['upload_dir']}")
    print(f"🐍 Python: {APP_CONFIG['python_bin']}")
    print(f"🎯 Face DB: {APP_CONFIG['faces_db_dir']}")
    print(f"🌐 Starting Flask server on http://0.0.0.0:5000")
    print("⚠️  Debug mode: OFF (production mode for better performance)")
    
    app.run(
        host='0.0.0.0',
        port=5000,
        debug=False,      # Tắt debug để tránh connection leak
        threaded=True,    # Cho phép xử lý nhiều request cùng lúc
        use_reloader=False  # Tắt auto-reload
    )
