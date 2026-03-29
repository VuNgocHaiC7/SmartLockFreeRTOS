"""
Database connection module for Project_Q
"""
import mysql.connector
from mysql.connector import pooling
import sys
import os

# Add parent directory to path to import config
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from config.env import DB_CONFIG

# Connection pool
_connection_pool = None

def get_connection_pool():
    """Get or create MySQL connection pool"""
    global _connection_pool
    if _connection_pool is None:
        _connection_pool = pooling.MySQLConnectionPool(
            pool_name="project_q_pool",
            pool_size=20,  # Tăng pool size từ 5 lên 20
            pool_reset_session=True,
            host=DB_CONFIG['host'],
            port=DB_CONFIG['port'],
            database=DB_CONFIG['database'],
            user=DB_CONFIG['user'],
            password=DB_CONFIG['password'],
            charset=DB_CONFIG['charset']
        )
    return _connection_pool

def get_connection():
    """Get a database connection from pool"""
    pool = get_connection_pool()
    conn = pool.get_connection()
    # Ensure NOW() and DATETIME/TIMESTAMP behavior are aligned with Hanoi timezone.
    cursor = conn.cursor()
    try:
        cursor.execute("SET time_zone = '+07:00'")
    finally:
        cursor.close()
    return conn

def execute_query(query, params=None, fetch_one=False, fetch_all=False):
    """
    Execute a SQL query
    
    Args:
        query: SQL query string
        params: Query parameters (tuple or dict)
        fetch_one: If True, return first row
        fetch_all: If True, return all rows
        
    Returns:
        Query results or None
    """
    conn = None
    cursor = None
    try:
        conn = get_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(query, params or ())
        
        if fetch_one:
            result = cursor.fetchone()
        elif fetch_all:
            result = cursor.fetchall()
        else:
            conn.commit()
            result = cursor.lastrowid
        
        return result
    except Exception as e:
        if conn:
            conn.rollback()
        raise e
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()

class Database:
    """Database context manager for transactions"""
    
    def __init__(self):
        self.conn = None
        self.cursor = None
    
    def __enter__(self):
        self.conn = get_connection()
        self.cursor = self.conn.cursor(dictionary=True)
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is None:
            self.conn.commit()
        else:
            self.conn.rollback()
        
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
    
    def execute(self, query, params=None):
        """Execute query"""
        self.cursor.execute(query, params or ())
        return self.cursor.lastrowid
    
    def fetch_one(self, query, params=None):
        """Fetch one row"""
        self.cursor.execute(query, params or ())
        return self.cursor.fetchone()
    
    def fetch_all(self, query, params=None):
        """Fetch all rows"""
        self.cursor.execute(query, params or ())
        return self.cursor.fetchall()
