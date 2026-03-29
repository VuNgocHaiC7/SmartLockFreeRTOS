"""
Authentication module for Project_Q
"""
from functools import wraps
from flask import request
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from src.db import execute_query
from src.helpers import error_response

def check_api_key(api_key):
    """
    Validate API key and update last used timestamp
    
    Args:
        api_key: API key string
        
    Returns:
        Dict with API key info or None if invalid
    """
    if not api_key:
        return None
    
    # Check if API key exists
    row = execute_query(
        'SELECT * FROM api_keys WHERE api_key = %s',
        (api_key,),
        fetch_one=True
    )
    
    if not row:
        return None
    
    # Update last used timestamp
    execute_query(
        'UPDATE api_keys SET last_used_at = NOW() WHERE id = %s',
        (row['id'],)
    )
    
    return row

def check_device_auth(device_id, token):
    """
    Validate device authentication
    
    Args:
        device_id: Device ID
        token: Device secret token
        
    Returns:
        Dict with device info or None if invalid
    """
    row = execute_query(
        'SELECT * FROM devices WHERE id = %s AND secret = %s AND is_active = 1',
        (device_id, token),
        fetch_one=True
    )
    
    return row

def require_api_key(f):
    """
    Decorator to require valid API key for endpoint
    
    Usage:
        @app.route('/api/endpoint')
        @require_api_key
        def endpoint():
            ...
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Try to get API key from header or query param
        api_key = request.headers.get('X-API-KEY') or request.args.get('api_key')
        
        if not api_key:
            return error_response('Missing API key', 401)
        
        # Validate API key
        key_info = check_api_key(api_key)
        if not key_info:
            return error_response('Invalid API key', 401)
        
        # Store API key info in request context
        request.api_key_info = key_info
        
        return f(*args, **kwargs)
    
    return decorated_function

def require_device_auth(f):
    """
    Decorator to require valid device authentication
    
    Usage:
        @app.route('/api/device/endpoint')
        @require_device_auth
        def endpoint():
            ...
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        device_id = request.args.get('device_id') or request.json.get('device_id')
        token = request.args.get('token') or request.json.get('token')
        
        if not device_id or not token:
            return error_response('Missing device credentials', 401)
        
        # Validate device
        device_info = check_device_auth(device_id, token)
        if not device_info:
            return error_response('Unauthorized device', 401)
        
        # Store device info in request context
        request.device_info = device_info
        
        return f(*args, **kwargs)
    
    return decorated_function
