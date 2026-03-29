"""
Cache Management Tool
Quản lý cache của face recognition để tối ưu performance
"""
import os
import glob
import json
from datetime import datetime

def get_cache_info(faces_db_dir='faces_db'):
    """Lấy thông tin về cache hiện tại"""
    cache_files = [
        'faces_db/.encodings_cache.pkl',
        'faces_db/.encodings_cache_v2.pkl'
    ]
    
    info = []
    for cache_file in cache_files:
        cache_path = os.path.join(faces_db_dir, os.path.basename(cache_file))
        if os.path.exists(cache_path):
            size = os.path.getsize(cache_path)
            mtime = os.path.getmtime(cache_path)
            dt = datetime.fromtimestamp(mtime)
            
            info.append({
                'file': cache_file,
                'exists': True,
                'size_kb': round(size / 1024, 2),
                'modified': dt.strftime('%Y-%m-%d %H:%M:%S'),
                'age_hours': round((datetime.now().timestamp() - mtime) / 3600, 1)
            })
        else:
            info.append({
                'file': cache_file,
                'exists': False
            })
    
    return info

def clear_cache(faces_db_dir='faces_db'):
    """Xóa tất cả cache files"""
    cache_patterns = [
        'faces_db/.encodings_cache*.pkl',
        'faces_db/__pycache__'
    ]
    
    deleted = []
    for pattern in cache_patterns:
        for path in glob.glob(pattern):
            try:
                if os.path.isfile(path):
                    os.remove(path)
                    deleted.append(path)
                    print(f"✓ Deleted: {path}")
            except Exception as e:
                print(f"✗ Error deleting {path}: {e}")
    
    return deleted

def rebuild_cache():
    """Force rebuild cache bằng cách chạy face_check một lần"""
    import sys
    import subprocess
    
    # Tìm một ảnh test bất kỳ
    test_images = glob.glob('faces_db/*.jpg') + glob.glob('faces_db/*.png')
    
    if not test_images:
        print("⚠ No test images found in faces_db/")
        print("Tip: Add a test image to rebuild cache")
        return False
    
    test_img = test_images[0]
    print(f"Rebuilding cache with: {test_img}")
    
    cmd = [
        sys.executable,
        'face_check.py',
        '--image', test_img,
        '--db', 'faces_db',
        '--tolerance', '0.8'
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            print(f"✓ Cache rebuilt in {data['latency_ms']}ms")
            print(f"  DB count: {data['db_count']}")
            return True
        else:
            print(f"✗ Error: {result.stderr}")
            return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

def main():
    import argparse
    
    ap = argparse.ArgumentParser(description='Face Recognition Cache Management')
    ap.add_argument('action', choices=['info', 'clear', 'rebuild'], 
                   help='Action to perform')
    args = ap.parse_args()
    
    print("=" * 60)
    print("FACE RECOGNITION CACHE MANAGEMENT")
    print("=" * 60)
    
    if args.action == 'info':
        print("\nCache Information:")
        print("-" * 60)
        for cache in get_cache_info():
            print(f"\nFile: {cache['file']}")
            if cache['exists']:
                print(f"  Size: {cache['size_kb']} KB")
                print(f"  Modified: {cache['modified']}")
                print(f"  Age: {cache['age_hours']} hours")
            else:
                print("  Status: Not found")
        
        # DB stats
        db_images = glob.glob('faces_db/*.jpg') + glob.glob('faces_db/*.png')
        print(f"\nDatabase Images: {len(db_images)}")
        
    elif args.action == 'clear':
        print("\nClearing cache...")
        print("-" * 60)
        deleted = clear_cache()
        if deleted:
            print(f"\n✓ Deleted {len(deleted)} file(s)")
        else:
            print("\n⚠ No cache files found")
    
    elif args.action == 'rebuild':
        print("\nRebuilding cache...")
        print("-" * 60)
        clear_cache()
        print()
        if rebuild_cache():
            print("\n✓ Cache rebuilt successfully")
        else:
            print("\n✗ Failed to rebuild cache")
    
    print()

if __name__ == '__main__':
    main()
