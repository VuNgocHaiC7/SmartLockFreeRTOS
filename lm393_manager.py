"""
LM393 System Manager - Helper Script
Quản lý và cấu hình hệ thống nhận diện tự động
"""
import sys
import os
import argparse
import mysql.connector
from datetime import datetime, timedelta

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))
from config.env import DB_CONFIG, APP_CONFIG

def get_db_connection():
    """Get database connection"""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except Exception as e:
        print(f"❌ Không thể kết nối database: {e}")
        sys.exit(1)

def show_statistics(days=7):
    """Hiển thị thống kê hệ thống"""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    print("\n" + "=" * 60)
    print(f"📊 THỐNG KÊ HỆ THỐNG ({days} NGÀY GẦN NHẤT)")
    print("=" * 60)
    
    # Tổng quan
    cursor.execute(f"""
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'granted' THEN 1 ELSE 0 END) as granted,
            SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) as denied,
            AVG(confidence) as avg_confidence
        FROM access_logs 
        WHERE timestamp >= DATE_SUB(NOW(), INTERVAL {days} DAY)
    """)
    
    stats = cursor.fetchone()
    
    print(f"\nTổng quan:")
    print(f"   Tổng số lần phát hiện: {stats['total']}")
    print(f"   Cho phép (granted):   {stats['granted']} ({stats['granted']/max(stats['total'],1)*100:.1f}%)")
    print(f"   Từ chối (denied):     {stats['denied']} ({stats['denied']/max(stats['total'],1)*100:.1f}%)")
    print(f"   Độ tin cậy TB:       {stats['avg_confidence']:.2f}%")
    
    # Top người được nhận diện
    cursor.execute(f"""
        SELECT 
            recognized_name,
            COUNT(*) as count,
            AVG(confidence) as avg_conf
        FROM access_logs 
        WHERE timestamp >= DATE_SUB(NOW(), INTERVAL {days} DAY)
            AND status = 'granted'
            AND recognized_name IS NOT NULL
        GROUP BY recognized_name
        ORDER BY count DESC
        LIMIT 5
    """)
    
    top_people = cursor.fetchall()
    
    if top_people:
        print(f"\n👥 Top người được nhận diện:")
        for i, person in enumerate(top_people, 1):
            print(f"   {i}. {person['recognized_name']:20} - {person['count']:3} lần (conf: {person['avg_conf']:.1f}%)")
    
    # Thống kê theo ngày
    cursor.execute(f"""
        SELECT 
            DATE(timestamp) as date,
            COUNT(*) as total,
            SUM(CASE WHEN status = 'granted' THEN 1 ELSE 0 END) as granted
        FROM access_logs 
        WHERE timestamp >= DATE_SUB(NOW(), INTERVAL {days} DAY)
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
        LIMIT 7
    """)
    
    daily = cursor.fetchall()
    
    if daily:
        print(f"\nThống kê theo ngày:")
        for day in daily:
            date_str = day['date'].strftime('%Y-%m-%d')
            bar = "B" * min(day['total'], 50)
            print(f"   {date_str}: {bar} {day['total']} (✓{day['granted']})")
    
    cursor.close()
    conn.close()
    
    print("\n" + "=" * 60 + "\n")

def show_recent_logs(limit=10):
    """Hiển thị log gần nhất"""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    print("\n" + "=" * 80)
    print(f" {limit} LOG GẦN NHẤT")
    print("=" * 80)
    
    cursor.execute(f"""
        SELECT 
            id,
            device_id,
            recognized_name,
            confidence,
            status,
            timestamp
        FROM access_logs 
        ORDER BY timestamp DESC 
        LIMIT {limit}
    """)
    
    logs = cursor.fetchall()
    
    if not logs:
        print("   Chưa có log nào")
    else:
        print(f"\n{'ID':>5} {'Device':10} {'Name':20} {'Conf':>6} {'Status':10} {'Time':20}")
        print("-" * 80)
        
        for log in logs:
            status_icon = "✓" if log['status'] == 'granted' else "✗"
            name = log['recognized_name'] or 'Unknown'
            conf = f"{log['confidence']:.1f}%" if log['confidence'] else "N/A"
            time_str = log['timestamp'].strftime('%Y-%m-%d %H:%M:%S')
            
            print(f"{log['id']:>5} {log['device_id']:10} {name:20} {conf:>6} "
                  f"{status_icon} {log['status']:9} {time_str:20}")
    
    cursor.close()
    conn.close()
    
    print("\n" + "=" * 80 + "\n")

def clear_old_logs(days=30):
    """Xóa log cũ hơn X ngày"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    print(f"\n Xóa log cũ hơn {days} ngày...")
    
    # Đếm số log sẽ xóa
    cursor.execute(f"""
        SELECT COUNT(*) as count
        FROM access_logs 
        WHERE timestamp < DATE_SUB(NOW(), INTERVAL {days} DAY)
    """)
    
    count = cursor.fetchone()[0]
    
    if count == 0:
        print("   ✓ Không có log nào cần xóa")
    else:
        confirm = input(f"Sẽ xóa {count} log. Tiếp tục? (y/N): ")
        
        if confirm.lower() == 'y':
            cursor.execute(f"""
                DELETE FROM access_logs 
                WHERE timestamp < DATE_SUB(NOW(), INTERVAL {days} DAY)
            """)
            conn.commit()
            print(f"   ✓ Đã xóa {count} log")
        else:
            print("   Đã hủy")
    
    cursor.close()
    conn.close()
    print()

def export_logs(output_file=None, days=7):
    """Export logs ra file CSV"""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    if not output_file:
        output_file = f"access_logs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    
    print(f"\nExport logs ra {output_file}...")
    
    cursor.execute(f"""
        SELECT *
        FROM access_logs 
        WHERE timestamp >= DATE_SUB(NOW(), INTERVAL {days} DAY)
        ORDER BY timestamp DESC
    """)
    
    logs = cursor.fetchall()
    
    if not logs:
        print("Không có log nào để export")
        return
    
    # Write CSV
    import csv
    
    with open(output_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=logs[0].keys())
        writer.writeheader()
        writer.writerows(logs)
    
    print(f"   ✓ Đã export {len(logs)} log vào {output_file}")
    
    cursor.close()
    conn.close()
    print()

def check_system():
    """Kiểm tra trạng thái hệ thống"""
    print("\n" + "=" * 60)
    print("🔍 KIỂM TRA HỆ THỐNG")
    print("=" * 60 + "\n")
    
    # Database
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM devices")
        device_count = cursor.fetchone()[0]
        print(f"✓ Database: OK ({device_count} devices)")
        cursor.close()
        conn.close()
    except Exception as e:
        print(f"✗ Database: FAIL - {e}")
    
    # Upload directory
    upload_dir = APP_CONFIG['upload_dir']
    if os.path.exists(upload_dir):
        print(f"✓ Upload directory: OK ({upload_dir})")
    else:
        print(f"✗ Upload directory: NOT FOUND ({upload_dir})")
    
    # Python binary
    python_bin = APP_CONFIG['python_bin']
    if os.path.exists(python_bin):
        print(f"Python binary: OK ({python_bin})")
    else:
        print(f"Python binary: NOT FOUND ({python_bin})")
    
    # Face DB
    face_db = APP_CONFIG['faces_db_dir']
    if os.path.exists(face_db):
        face_count = len([f for f in os.listdir(face_db) if os.path.isdir(os.path.join(face_db, f))])
        print(f"Face database: OK ({face_count} persons)")
    else:
        print(f"Face database: NOT FOUND ({face_db})")
    
    # Tools directory
    tools_dir = APP_CONFIG['tools_dir']
    face_check_script = os.path.join(tools_dir, 'face_check.py')
    if os.path.exists(face_check_script):
        print(f"✓ Face check script: OK")
    else:
        print(f"✗ Face check script: NOT FOUND ({face_check_script})")
    
    # Config
    print(f"\nCấu hình:")
    print(f"   LM393 Enabled: {APP_CONFIG.get('lm393_enabled', 'N/A')}")
    print(f"   Cooldown: {APP_CONFIG.get('lm393_cooldown_ms', 'N/A')}ms")
    print(f"   Tolerance: {APP_CONFIG.get('tolerance', 'N/A')}")
    print(f"   Save Photos: {APP_CONFIG.get('save_unlock_photos', 'N/A')}")
    
    print("\n" + "=" * 60 + "\n")

def main():
    parser = argparse.ArgumentParser(
        description='LM393 System Manager',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python lm393_manager.py stats              # Xem thống kê
  python lm393_manager.py stats --days 30    # Thống kê 30 ngày
  python lm393_manager.py logs               # Xem 10 log gần nhất
  python lm393_manager.py logs --limit 50    # Xem 50 log gần nhất
  python lm393_manager.py check              # Kiểm tra hệ thống
  python lm393_manager.py export             # Export logs
  python lm393_manager.py clean --days 90    # Xóa log cũ hơn 90 ngày
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Commands')
    
    # Stats command
    stats_parser = subparsers.add_parser('stats', help='Xem thống kê')
    stats_parser.add_argument('--days', type=int, default=7, help='Số ngày (default: 7)')
    
    # Logs command
    logs_parser = subparsers.add_parser('logs', help='Xem log gần nhất')
    logs_parser.add_argument('--limit', type=int, default=10, help='Số lượng log (default: 10)')
    
    # Export command
    export_parser = subparsers.add_parser('export', help='Export logs ra CSV')
    export_parser.add_argument('--output', type=str, help='Output file name')
    export_parser.add_argument('--days', type=int, default=7, help='Số ngày (default: 7)')
    
    # Clean command
    clean_parser = subparsers.add_parser('clean', help='Xóa log cũ')
    clean_parser.add_argument('--days', type=int, default=30, help='Xóa log cũ hơn X ngày (default: 30)')
    
    # Check command
    subparsers.add_parser('check', help='Kiểm tra trạng thái hệ thống')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    # Execute command
    if args.command == 'stats':
        show_statistics(args.days)
    elif args.command == 'logs':
        show_recent_logs(args.limit)
    elif args.command == 'export':
        export_logs(args.output, args.days)
    elif args.command == 'clean':
        clear_old_logs(args.days)
    elif args.command == 'check':
        check_system()

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nĐã hủy bởi user")
        sys.exit(0)
    except Exception as e:
        print(f"\nLỗi: {e}")
        sys.exit(1)
