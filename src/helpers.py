"""
Helper functions for Project_Q
"""
import os
import json
from datetime import datetime
from flask import jsonify, make_response
import sys

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from config.env import APP_CONFIG

def json_response(data, status_code=200):
    """
    Create JSON response with proper headers
    
    Args:
        data: Data to serialize to JSON
        status_code: HTTP status code
        
    Returns:
        Flask response object
    """
    response = make_response(jsonify(data), status_code)
    response.headers['Content-Type'] = 'application/json; charset=utf-8'
    return response

def error_response(message, status_code=400):
    """
    Create error JSON response
    
    Args:
        message: Error message
        status_code: HTTP status code
        
    Returns:
        Flask response object
    """
    return json_response({'ok': False, 'error': message}, status_code)

def success_response(data=None, **kwargs):
    """
    Create success JSON response
    
    Args:
        data: Optional data dict
        **kwargs: Additional key-value pairs
        
    Returns:
        Flask response object
    """
    response_data = {'ok': True}
    if data:
        response_data.update(data)
    response_data.update(kwargs)
    return json_response(response_data)

def require_fields(fields, source):
    """
    Check if required fields exist in source dict
    
    Args:
        fields: List of required field names
        source: Dict to check
        
    Returns:
        Tuple (success: bool, missing_fields: list)
    """
    missing = []
    for field in fields:
        if field not in source or source[field] == '':
            missing.append(field)
    
    return (len(missing) == 0, missing)

def ensure_upload_dir():
    """
    Ensure upload directory exists and create daily subdirectory
    
    Returns:
        Tuple (day_str, day_path)
    """
    upload_dir = APP_CONFIG['upload_dir']
    
    # Create main upload dir if not exists
    if not os.path.exists(upload_dir):
        os.makedirs(upload_dir, exist_ok=True)
    
    # Create daily subdirectory
    day = datetime.now().strftime('%Y%m%d')
    day_path = os.path.join(upload_dir, day)
    
    if not os.path.exists(day_path):
        os.makedirs(day_path, exist_ok=True)
    
    return day, day_path

def validate_ip(ip):
    """
    Validate IP address format
    
    Args:
        ip: IP address string
        
    Returns:
        bool: True if valid
    """
    parts = ip.split('.')
    if len(parts) != 4:
        return False
    
    try:
        return all(0 <= int(part) <= 255 for part in parts)
    except (ValueError, TypeError):
        return False
