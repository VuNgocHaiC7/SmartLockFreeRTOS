<!doctype html>
<html lang="vi">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hệ thống Khóa Thông Minh FreeRTOS</title>
  <link rel="stylesheet" href="style.css" />
  <link
    rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>

<body>
  <!-- Toast Notification Container -->
  <div id="toast-container"></div>

  <div class="container">
    <div id="login-screen">
      <h2>Đăng Nhập Hệ Thống</h2>
      <p class="login-description">
        <i class="fas fa-shield-alt"></i> Điều Khiển Khóa Thông Minh FreeRTOS
      </p>

      <input type="email" id="email" placeholder="Nhập địa chỉ email..." />
      <input
        type="password"
        id="password"
        placeholder="Nhập mật khẩu..." />

      <button class="btn btn-primary" onclick="handleLogin()">
        <i class="fas fa-sign-in-alt"></i><span>Đăng Nhập</span>
      </button>
      <p id="login-msg" class="login-msg"></p>
    </div>

    <div id="dashboard-screen" class="hidden">
      <div class="header">
        <div class="user-info">
          <div class="user-avatar">
            <i class="fas fa-user"></i>
          </div>
          <div>
            <div class="status-badge">
              <span id="status-dot" class="dot"></span>
              <span id="status-text">Đã kết nối</span>
            </div>
            <div class="user-email" id="user-email">user@example.com</div>
          </div>
        </div>
        <div class="header-actions">
          <button
            class="icon-btn"
            onclick="toggleDarkMode()"
            title="Chế độ tối">
            <i class="fas fa-moon"></i>
          </button>
          <button class="btn btn-outline" onclick="handleLogout()">
            <i class="fas fa-sign-out-alt"></i> Đăng Xuất
          </button>
        </div>
      </div>

      <!-- Tab Navigation -->
      <div class="tab-navigation">
        <button class="tab-btn active" onclick="switchTab('dashboard')">
          <i class="fas fa-home"></i>
          <span>Dashboard</span>
        </button>
        <button class="tab-btn" onclick="switchTab('stats')">
          <i class="fas fa-chart-line"></i>
          <span>Thống Kê</span>
        </button>
        <button class="tab-btn" onclick="switchTab('settings')">
          <i class="fas fa-cog"></i>
          <span>Cài Đặt</span>
        </button>
      </div>

      <!-- Dashboard Tab Content -->
      <div id="tab-dashboard" class="tab-content active">
        <div class="camera-container">
          <div id="rec-indicator" class="rec-dot">● LIVE</div>
          <img id="cam-stream" src="" class="cam-stream-img" />

          <div id="cam-placeholder" class="cam-placeholder-content">
            <i class="fas fa-video-slash cam-placeholder-icon"></i>
            <div class="cam-placeholder-title">Camera Đang Tắt</div>
            <div class="cam-placeholder-subtitle">
              Nhấn nút bên dưới để kích hoạt
            </div>
          </div>
        </div>

        <div class="settings-section face-storage-section">
          <h4 class="face-storage-title">
            <i class="fas fa-camera"></i> Thêm Ảnh Khuôn Mặt Từ Camera
          </h4>

          <div class="face-add-row">
            <input
              type="text"
              id="face-name-input"
              class="face-name-input"
              placeholder="Nhập tên người cần thêm..." />
            <button class="btn btn-primary face-add-btn" onclick="addFaceFromEsp32()">
              <i class="fas fa-camera"></i>
              <span>Thêm Từ Camera</span>
            </button>
          </div>

          <div class="face-storage-hint">
            Chụp trực tiếp từ camera đang stream để thêm vào kho khuôn mặt.
          </div>
        </div>

        <div class="control-grid">
          <button class="btn btn-success" onclick="sendCommand('UNLOCK')">
            <i class="fas fa-unlock"></i><span>Mở Khóa</span>
          </button>
          <button class="btn btn-warning" onclick="sendCommand('FACE_AUTH')">
            <i class="fas fa-user-check"></i><span>Face ID</span>
          </button>
          <button class="btn btn-primary" onclick="sendCommand('CAM_ON')">
            <i class="fas fa-video"></i><span>Bật Camera</span>
          </button>
          <button class="btn btn-danger" onclick="sendCommand('CAM_OFF')">
            <i class="fas fa-video-slash"></i><span>Tắt Camera</span>
          </button>
        </div>

        <h4 class="activity-log-header">
          <i class="fas fa-history"></i>Nhật Ký Hoạt Động
        </h4>
        <div class="log-box" id="log-list">
          <div class="loading-text">Đang tải dữ liệu...</div>
        </div>
      </div>

      <!-- Statistics Tab Content -->
      <div id="tab-stats" class="tab-content">
        <h3 class="section-title">
          <i class="fas fa-chart-bar"></i> Thống Kê Hoạt Động
        </h3>

        <div class="chart-container">
          <canvas id="activityChart"></canvas>
        </div>

        <div class="stats-summary">
          <div class="summary-card">
            <div class="summary-icon blue">
              <i class="fas fa-calendar-week"></i>
            </div>
            <div class="summary-info">
              <div class="summary-label">Tuần này</div>
              <div class="summary-value" id="stat-week">0 lần</div>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon green">
              <i class="fas fa-calendar-alt"></i>
            </div>
            <div class="summary-info">
              <div class="summary-label">Tháng này</div>
              <div class="summary-value" id="stat-month">0 lần</div>
            </div>
          </div>
        </div>

        <div class="recent-activities">
          <h4><i class="fas fa-clock"></i> Hoạt động gần đây nhất</h4>
          <div id="recent-list" class="log-box"></div>
        </div>
      </div>

      <!-- Settings Tab Content -->
      <div id="tab-settings" class="tab-content">
        <h3 class="section-title">
          <i class="fas fa-sliders-h"></i> Cài Đặt
        </h3>

        <div class="settings-section">
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">
                <i class="fas fa-bell"></i> Thông báo âm thanh
              </div>
              <div class="setting-desc">Phát âm thanh khi có hoạt động</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="sound-toggle" checked />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">
                <i class="fas fa-lock-open"></i> Tự động khóa lại
              </div>
              <div class="setting-desc">Tự động khóa sau khi mở</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="auto-lock-toggle" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">
                <i class="fas fa-clock"></i> Thời gian tự động khóa
              </div>
              <div class="setting-desc">Thời gian chờ trước khi khóa lại</div>
            </div>
            <select class="setting-select">
              <option value="5">5 giây</option>
              <option value="10" selected>10 giây</option>
              <option value="30">30 giây</option>
              <option value="60">60 giây</option>
            </select>
          </div>

        </div>

        <div class="settings-section face-storage-section">
          <h4 class="face-storage-title">
            <i class="fas fa-users"></i> Danh Sách Khuôn Mặt Đã Lưu
          </h4>

          <div class="face-storage-list-header">
            <span>Danh sách khuôn mặt đã lưu</span>
            <button class="btn btn-outline face-refresh-btn" onclick="refreshFacesStorage()">
              Tải lại
            </button>
          </div>

          <div id="face-storage-list" class="face-storage-list">
            <div class="loading-text">Đang tải danh sách khuôn mặt...</div>
          </div>
        </div>

        <div class="danger-zone">
          <h4><i class="fas fa-exclamation-triangle"></i> Vùng nguy hiểm</h4>
          <button class="btn btn-danger" onclick="clearAllLogs()">
            <i class="fas fa-trash"></i><span>Xóa tất cả nhật ký</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Application JavaScript -->
  <script type="module" src="featureWeb.js"></script>
</body>

</html>