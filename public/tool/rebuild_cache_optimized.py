"""
Rebuild Face Database Cache với Settings Tối Ưu
Run this after optimization changes to rebuild cache with new settings
"""
import os
import glob
import sys

def main():
    print("=" * 60)
    print("🔄 REBUILDING FACE DATABASE CACHE (OPTIMIZED)")
    print("=" * 60)
    
    # Step 1: Clear old caches
    print("\n1️⃣  Clearing old caches...")
    cache_files = [
        'faces_db/.encodings_cache.pkl',
        'faces_db/.encodings_cache_v2.pkl'
    ]
    
    deleted_count = 0
    for cache_file in cache_files:
        if os.path.exists(cache_file):
            try:
                os.remove(cache_file)
                print(f"   ✅ Deleted: {cache_file}")
                deleted_count += 1
            except Exception as e:
                print(f"   ⚠️  Error deleting {cache_file}: {e}")
        else:
            print(f"   ℹ️  Not found: {cache_file}")
    
    if deleted_count == 0:
        print("   ℹ️  No old caches found (fresh start)")
    
    # Step 2: Count database images
    print("\n2️⃣  Scanning database...")
    db_images = glob.glob('faces_db/*.jpg') + glob.glob('faces_db/*.png')
    db_images = [f for f in db_images if not os.path.basename(f).startswith('.')]
    
    if len(db_images) == 0:
        print("   ⚠️  WARNING: No images found in faces_db/")
        print("   Add face images before rebuilding cache!")
        return
    
    print(f"   ✅ Found {len(db_images)} face image(s)")
    
    # List first few
    for i, img in enumerate(db_images[:5]):
        name = os.path.splitext(os.path.basename(img))[0]
        print(f"      - {name}")
    if len(db_images) > 5:
        print(f"      ... and {len(db_images) - 5} more")
    
    # Step 3: Rebuild PRODUCTION cache
    print("\n3️⃣  Building PRODUCTION cache (face_check.py)...")
    print("   Settings: 640px, upsample=1, jitters=2, quality=HIGH")
    
    import subprocess
    test_img = db_images[0]
    
    cmd = [
        sys.executable,
        'face_check.py',
        '--image', test_img,
        '--db', 'faces_db',
        '--tolerance', '0.6'
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=os.path.dirname(__file__))
        if result.returncode == 0:
            import json
            data = json.loads(result.stdout)
            print(f"   ✅ Cache built in {data['latency_ms']}ms")
            print(f"   ✅ Loaded {data['db_count']} face(s)")
            
            # Show timing breakdown
            if 'timing' in data:
                print(f"   Timing breakdown:")
                for key, val in data['timing'].items():
                    print(f"      - {key}: {val}ms")
        else:
            print(f"   ⚠️  Error building cache:")
            print(f"   {result.stderr}")
            return
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return
    
    # Summary
    print("\n" + "=" * 60)
    print("✅ CACHE REBUILD COMPLETE!")
    print("=" * 60)
    print(f"Database: {len(db_images)} face(s)")
    print("Production cache: READY (high accuracy)")
    print("\nNext steps:")
    print("1. Test with: python face_check.py --image <test_image> --db faces_db")
    print("2. Upload ESP32 firmware")
    print("3. Test full system via web interface")
    print()

if __name__ == '__main__':
    main()
