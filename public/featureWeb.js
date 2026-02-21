// app.js - Smart Lock FreeRTOS Controller
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  onValue,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyCaLdNOZa8g8vY4rb0hn3GhF4-JYNTEYlc",
  authDomain: "smartlockfreertos.firebaseapp.com",
  databaseURL:
    "https://smartlockfreertos-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smartlockfreertos",
  storageBucket: "smartlockfreertos.firebasestorage.app",
  messagingSenderId: "1081953224610",
  appId: "1:1081953224610:web:5971fa08c316fd6da6d4fb",
  measurementId: "G-CQE013KTRY",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// UI Elements
const ui = {
  loginScreen: document.getElementById("login-screen"),
  dashScreen: document.getElementById("dashboard-screen"),
  statusDot: document.getElementById("status-dot"),
  camPlaceholder: document.getElementById("cam-placeholder"),
  camStream: document.getElementById("cam-stream"),
  recDot: document.getElementById("rec-indicator"),
  loginMsg: document.getElementById("login-msg"),
};

// Global Variables
let activityChart = null;
let statsData = { today: 0, week: 0, month: 0, cam: 0, total: 0 };

// ==================== AUTHENTICATION ====================

// Login Handler
window.handleLogin = () => {
  const email = document.getElementById("email").value;
  const pass = document.getElementById("password").value;
  ui.loginMsg.innerText = "Đang xác thực...";

  signInWithEmailAndPassword(auth, email, pass).catch((error) => {
    ui.loginMsg.innerText = "Lỗi: Sai tài khoản hoặc mật khẩu!";
  });
};

// Logout Handler
window.handleLogout = () => {
  signOut(auth);
};

// Auth State Observer
onAuthStateChanged(auth, (user) => {
  if (user) {
    // User logged in -> Show Dashboard
    ui.loginScreen.classList.add("hidden");
    ui.dashScreen.classList.remove("hidden");
    ui.statusDot.classList.add("online");
    document.getElementById("user-email").innerText = user.email;
    loadHistory();
    initChart();

    listenToCameraIP();
  } else {
    // User logged out -> Show Login
    ui.loginScreen.classList.remove("hidden");
    ui.dashScreen.classList.add("hidden");
    ui.statusDot.classList.remove("online");
    ui.loginMsg.innerText = "";
  }
});

// ==================== COMMAND CONTROL ====================

window.sendCommand = (cmd) => {
  // Write command to Firebase
  set(ref(db, "command"), {
    action: cmd,
    user: auth.currentUser.email,
    timestamp: Date.now(),
  });

  // UI Feedback
  if (cmd === "CAM_ON") {
    ui.camPlaceholder.classList.add("hidden");
    ui.recDot.style.display = "block";
    ui.camPlaceholder.innerHTML =
      "<div style='color:#28a745'>Đang kết nối...</div>";
    ui.camPlaceholder.classList.remove("hidden");
    showToast("📹 Camera đang được bật...", "info");
  } else if (cmd === "CAM_OFF") {
    ui.recDot.style.display = "none";
    ui.camStream.style.display = "none";
    ui.camPlaceholder.innerHTML =
      '<i class="fas fa-video-slash" style="font-size: 40px; margin-bottom: 10px; opacity: 0.5;"></i><div>Camera đang tắt</div>';
    ui.camPlaceholder.classList.remove("hidden");
    showToast("📴 Camera đã tắt", "success");
  } else if (cmd === "UNLOCK") {
    showToast("🔓 Đã gửi lệnh mở khóa!", "success");
  }
};

// ==================== DATA & STATISTICS ====================

function loadHistory() {
  onValue(ref(db, "logs"), (snapshot) => {
    const data = snapshot.val();
    const list = document.getElementById("log-list");
    const recentList = document.getElementById("recent-list");
    list.innerHTML = "";

    // Reset stats
    statsData = { today: 0, week: 0, month: 0, cam: 0, total: 0 };

    if (data) {
      const keys = Object.keys(data).slice(-10).reverse();
      const allKeys = Object.keys(data);

      // Calculate statistics
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

      allKeys.forEach((key) => {
        const item = data[key];
        const timestamp = item.timestamp || Date.now();
        const action = typeof item === "object" ? item.action : item;

        statsData.total++;

        if (timestamp > oneDayAgo) {
          if (action === "UNLOCK" || action?.includes("khóa"))
            statsData.today++;
        }
        if (timestamp > oneWeekAgo) {
          statsData.week++;
        }
        if (timestamp > oneMonthAgo) {
          statsData.month++;
        }
        if (action === "CAM_ON" || action?.includes("Camera")) {
          statsData.cam++;
        }
      });

      // Update stat cards
      document.getElementById("stat-today").innerText = statsData.today;
      document.getElementById("stat-cam").innerText = statsData.cam;
      document.getElementById("stat-total").innerText = statsData.total;
      document.getElementById("stat-week").innerText = statsData.week + " lần";
      document.getElementById("stat-month").innerText =
        statsData.month + " lần";

      // Display logs
      keys.forEach((key) => {
        const item = data[key];
        let msg = typeof item === "object" ? item.msg || item.action : item;
        let time = new Date(item.timestamp || Date.now()).toLocaleTimeString(
          "vi-VN",
        );

        const div = document.createElement("div");
        div.className = "log-item";
        div.innerHTML = `<span>${msg}</span> <span class="log-time">${time}</span>`;
        list.appendChild(div);

        if (recentList) {
          const div2 = div.cloneNode(true);
          recentList.appendChild(div2);
        }
      });

      updateChart();
    } else {
      list.innerHTML =
        "<div style='text-align:center; padding:10px; color:#999'>Chưa có dữ liệu</div>";
      if (recentList) {
        recentList.innerHTML =
          "<div style='text-align:center; padding:10px; color:#999'>Chưa có dữ liệu</div>";
      }
    }
  });
}

// ==================== CAMERA LISTENER ====================
function listenToCameraIP() {
  const camRef = ref(db, "cam_ip");

  onValue(camRef, (snapshot) => {
    const streamUrl = snapshot.val();

    // Nếu có link stream và không phải là lệnh "OFF"
    if (streamUrl && streamUrl !== "OFF") {
      console.log("Nhận được link stream:", streamUrl);

      // 1. Gán link vào thẻ img
      ui.camStream.src = streamUrl;

      // 2. Hiển thị thẻ img, ẩn placeholder
      ui.camStream.style.display = "block";
      ui.camPlaceholder.classList.add("hidden");

      // 3. Hiển thị chấm đỏ REC
      ui.recDot.style.display = "block";

      // 4. Cập nhật trạng thái text
      showToast("🎥 Đã kết nối Camera!", "success");
    } else {
      // Nếu là OFF hoặc không có dữ liệu
      console.log("Camera đã tắt");

      // 1. Ẩn thẻ img
      ui.camStream.style.display = "none";
      ui.camStream.src = ""; // Ngắt kết nối để tiết kiệm băng thông

      // 2. Hiện lại placeholder
      ui.camPlaceholder.innerHTML =
        '<i class="fas fa-video-slash" style="font-size: 40px; margin-bottom: 10px; opacity: 0.5;"></i><div>Camera đang tắt</div>';
      ui.camPlaceholder.classList.remove("hidden");

      // 3. Ẩn chấm đỏ
      ui.recDot.style.display = "none";
    }
  });
}

// ==================== UI NAVIGATION ====================

window.switchTab = (tabName) => {
  // Hide all tabs
  document.querySelectorAll(".tab-content").forEach((tab) => {
    tab.classList.remove("active");
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  // Show selected tab
  document.getElementById(`tab-${tabName}`).classList.add("active");
  event.target.closest(".tab-btn").classList.add("active");
};

// ==================== DARK MODE ====================

window.toggleDarkMode = () => {
  document.body.classList.toggle("dark-mode");
  const isDark = document.body.classList.contains("dark-mode");
  const icon = event.target.closest("button").querySelector("i");
  icon.className = isDark ? "fas fa-sun" : "fas fa-moon";
  showToast(isDark ? "🌙 Đã bật chế độ tối" : "☀️ Đã tắt chế độ tối", "info");
  localStorage.setItem("darkMode", isDark);
};

// Load dark mode preference
if (localStorage.getItem("darkMode") === "true") {
  document.body.classList.add("dark-mode");
}

// ==================== TOAST NOTIFICATIONS ====================

window.showToast = (message, type = "info") => {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fas ${
      type === "success"
        ? "fa-check-circle"
        : type === "error"
          ? "fa-exclamation-circle"
          : "fa-info-circle"
    }"></i>
    <span>${message}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("show");
  }, 100);

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
};

// ==================== SETTINGS ====================

window.clearAllLogs = () => {
  if (confirm("Bạn có chắc muốn xóa tất cả nhật ký?")) {
    set(ref(db, "logs"), null);
    showToast("🗑️ Đã xóa tất cả nhật ký", "success");
  }
};

// ==================== CHART ====================

function initChart() {
  const ctx = document.getElementById("activityChart");
  if (!ctx) return;

  activityChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "CN"],
      datasets: [
        {
          label: "Hoạt động",
          data: [12, 19, 8, 15, 10, 13, 7],
          borderColor: "#4f46e5",
          backgroundColor: "rgba(79, 70, 229, 0.1)",
          tension: 0.4,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            stepSize: 5,
          },
        },
      },
    },
  });
}

function updateChart() {
  if (activityChart) {
    activityChart.data.datasets[0].data = Array.from({ length: 7 }, () =>
      Math.floor(Math.random() * 20),
    );
    activityChart.update();
  }
}

// ==================== INITIALIZATION ====================

console.log("🚀 Smart Lock FreeRTOS - Application loaded successfully!");
