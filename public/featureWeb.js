// app.js - Smart Lock Local Controller (No Firebase)

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
let espBaseUrl = "";
let isDiscoveringController = false;
let cameraStatusPollTimer = null;
let isCameraUiOn = false;

// ==================== AUTHENTICATION (MOCK LOCAL) ====================

window.handleLogin = () => {
  const email = document.getElementById("email").value.trim();
  const pass = document.getElementById("password").value.trim();

  if (email === "" || pass === "") {
    ui.loginMsg.innerText = "Vui lòng nhập Email và Mật khẩu!";
    return;
  }

  ui.loginMsg.innerText = "Đang kết nối mạng Local...";

  // Giả lập độ trễ đăng nhập 0.5s cho giống thật
  setTimeout(async () => {
    ui.loginScreen.classList.add("hidden");
    ui.dashScreen.classList.remove("hidden");
    ui.statusDot.classList.add("online");
    document.getElementById("user-email").innerText = email;

    await initLocalController();
    startCameraStatusSync();
    loadHistory();
    initChart();
    showToast("✅ Đăng nhập mạng Local thành công!", "success");
  }, 500);
};

window.handleLogout = () => {
  stopCameraStatusSync();
  ui.loginScreen.classList.remove("hidden");
  ui.dashScreen.classList.add("hidden");
  ui.statusDot.classList.remove("online");
  ui.loginMsg.innerText = "";
  setCameraUiState(false);
};

// ==================== LOCAL CONTROLLER ====================

function normalizeControllerInput(rawValue) {
  const input = (rawValue || "").trim();
  if (!input) return "";
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const url = new URL(input);
      return `http://${url.host}`;
    } catch {
      return "";
    }
  }
  return `http://${input}`;
}

function inferControllerFromPage() {
  const host = window.location.hostname;
  const isLikelyLocalIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const isLikelyLanName = host.endsWith(".local");
  if (isLikelyLocalIp || isLikelyLanName) {
    return `http://${host}`;
  }
  return "";
}

function getStreamUrlFromBase(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `http://${url.hostname}:81/stream`;
  } catch {
    return "";
  }
}

function updateControllerUi() {
  const ipInfoBox = document.getElementById("camera-ip-info");
  const ipText = document.getElementById("camera-ip-text");

  if (!ipInfoBox || !ipText) return;

  ipInfoBox.classList.add("show");
  if (espBaseUrl) {
    ipText.textContent = espBaseUrl;
    ipText.className = "camera-ip-text ip-status-connected";
  } else if (isDiscoveringController) {
    ipText.textContent = "Đang tự động dò ESP32...";
    ipText.className = "camera-ip-text ip-status-disconnected";
  } else {
    ipText.textContent = "Chưa tìm thấy ESP32 trong mạng";
    ipText.className = "camera-ip-text ip-status-disconnected";
  }
}

function getDiscoveryCandidates() {
  const stored = normalizeControllerInput(
    localStorage.getItem("espBaseUrl") || "",
  );
  const inferred = inferControllerFromPage();
  const candidates = [
    stored,
    inferred,
    "http://smartlockcam.local",
    "http://esp32cam.local",
    "http://esp32.local",
  ];

  const uniq = [];
  for (const value of candidates) {
    if (value && !uniq.includes(value)) {
      uniq.push(value);
    }
  }
  return uniq;
}

async function pingController(baseUrl = espBaseUrl, timeoutMs = 1200) {
  if (!baseUrl) return false;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/action?cmd=PING`, {
      method: "GET",
      cache: "no-store",
      mode: "cors",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timerId);
  }
}

async function discoverControllerBase() {
  isDiscoveringController = true;
  updateControllerUi();

  const candidates = getDiscoveryCandidates();
  for (const candidate of candidates) {
    const reachable = await pingController(candidate, 1000);
    if (reachable) {
      espBaseUrl = candidate;
      localStorage.setItem("espBaseUrl", espBaseUrl);
      isDiscoveringController = false;
      updateControllerUi();
      return espBaseUrl;
    }
  }

  espBaseUrl = "";
  localStorage.removeItem("espBaseUrl");
  isDiscoveringController = false;
  updateControllerUi();
  return "";
}

window.rediscoverController = async () => {
  const found = await discoverControllerBase();
  if (found) {
    await syncCameraStateOnce();
    showToast(`✅ Đã tự động kết nối: ${found}`, "success");
  } else {
    showToast("⚠️ Không tìm thấy ESP32. Hãy kiểm tra cùng mạng WiFi.", "info");
  }
};

async function initLocalController() {
  const stored = localStorage.getItem("espBaseUrl") || "";
  espBaseUrl = normalizeControllerInput(stored) || inferControllerFromPage();

  if (espBaseUrl && (await pingController(espBaseUrl, 900))) {
    localStorage.setItem("espBaseUrl", espBaseUrl);
    updateControllerUi();
    return;
  }

  await discoverControllerBase();
}

function setCameraUiState(isOn, options = {}) {
  const shouldRefresh = options.refreshStream === true;

  if (isOn) {
    const streamUrl = getStreamUrlFromBase(espBaseUrl);
    if (!streamUrl) return;

    if (!isCameraUiOn || shouldRefresh) {
      ui.camStream.classList.add("hide");
      ui.camPlaceholder.innerHTML =
        '<div class="cam-placeholder-content"><i class="fas fa-spinner fa-spin cam-placeholder-icon"></i><div class="cam-placeholder-title">Đang kết nối camera...</div><div class="cam-placeholder-subtitle">Vui lòng chờ ESP32 phản hồi</div></div>';
      ui.camPlaceholder.classList.remove("hidden");
      ui.camStream.src = "";
      ui.camStream.src = `${streamUrl}?t=${Date.now()}`;
      setTimeout(() => {
        ui.camStream.classList.remove("hide");
        ui.camStream.classList.add("show");
        ui.camPlaceholder.classList.add("hidden");
      }, 450);
    }
  } else {
    ui.camStream.classList.add("hide");
    ui.camStream.src = "";
    ui.camPlaceholder.innerHTML =
      '<i class="fas fa-video-slash cam-placeholder-icon"></i><div class="cam-placeholder-title">Camera đang tắt</div>';
    ui.camPlaceholder.classList.remove("hidden");
  }

  isCameraUiOn = isOn;
}

async function fetchCameraEnabledState() {
  if (!espBaseUrl) return null;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${espBaseUrl}/status`, {
      method: "GET",
      cache: "no-store",
      mode: "cors",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data.camera_enabled !== "boolean") return null;
    return data.camera_enabled;
  } catch {
    return null;
  } finally {
    clearTimeout(timerId);
  }
}

async function syncCameraStateOnce() {
  const enabled = await fetchCameraEnabledState();
  if (enabled === null) return;

  if (enabled && !isCameraUiOn) {
    await applyCameraPreset();
    setCameraUiState(true, { refreshStream: true });
  } else if (!enabled && isCameraUiOn) {
    setCameraUiState(false);
  }
}

function startCameraStatusSync() {
  stopCameraStatusSync();
  cameraStatusPollTimer = setInterval(() => {
    syncCameraStateOnce();
  }, 700);
  syncCameraStateOnce();
}

function stopCameraStatusSync() {
  if (cameraStatusPollTimer) {
    clearInterval(cameraStatusPollTimer);
    cameraStatusPollTimer = null;
  }
}

// ==================== COMMAND CONTROL ====================

async function sendLocalCommand(cmd) {
  if (!espBaseUrl) {
    await initLocalController();
  }

  if (!espBaseUrl) {
    showToast("⚠️ Chưa tìm thấy ESP32 trong mạng LAN", "error");
    throw new Error("ESP32 IP not configured");
  }

  const reachable = await pingController(espBaseUrl, 900);
  if (!reachable) {
    await discoverControllerBase();
  }

  if (!espBaseUrl) {
    showToast("⚠️ Mất kết nối ESP32, không thể gửi lệnh", "error");
    throw new Error("ESP32 unreachable");
  }

  const response = await fetch(
    `${espBaseUrl}/action?cmd=${encodeURIComponent(cmd)}`,
    {
      method: "GET",
      cache: "no-store",
      mode: "cors",
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Local API failed");
  }
}

async function setCameraControl(variable, value) {
  if (!espBaseUrl) return;

  const response = await fetch(
    `${espBaseUrl}/control?var=${encodeURIComponent(variable)}&val=${encodeURIComponent(String(value))}`,
    {
      method: "GET",
      cache: "no-store",
      mode: "cors",
    },
  );

  if (!response.ok) {
    throw new Error(`Control ${variable} failed`);
  }
}

async function applyCameraPreset() {
  // Preset can bang giua do net va do tre cho stream LAN.
  const presets = [
    ["quality", 14],
    ["contrast", 1],
    ["brightness", 1],
    ["saturation", 1],
    ["ae_level", 0],
  ];

  for (const [variable, value] of presets) {
    try {
      await setCameraControl(variable, value);
    } catch (error) {
      console.warn(`Camera preset skipped: ${variable}`, error);
    }
  }
}

window.sendCommand = async (cmd) => {
  try {
    await sendLocalCommand(cmd);
  } catch (error) {
    console.error("Local command failed:", error);
    showToast("❌ Không gửi được lệnh đến ESP32", "error");
    return;
  }

  if (cmd === "CAM_ON") {
    await applyCameraPreset();
    setCameraUiState(true, { refreshStream: true });
    showToast("📹 Camera đang bật qua Local API", "success");
    saveLocalLog("Bật Camera");
  } else if (cmd === "CAM_OFF") {
    setCameraUiState(false);

    showToast("📴 Camera đã tắt qua Local API", "success");
    saveLocalLog("Tắt Camera");
  } else if (cmd === "UNLOCK") {
    showToast("🔓 Đã gửi lệnh mở khóa trực tiếp!", "success");
    saveLocalLog("Mở khóa (Web)");
  }
};

// ==================== DATA & STATISTICS (LOCAL STORAGE) ====================

function saveLocalLog(actionMsg) {
  let logs = JSON.parse(localStorage.getItem("smartLockLogs") || "[]");
  logs.push({ msg: actionMsg, timestamp: Date.now() });

  // Chỉ giữ lại 100 bản ghi gần nhất cho nhẹ bộ nhớ
  if (logs.length > 100) logs.shift();

  localStorage.setItem("smartLockLogs", JSON.stringify(logs));
  loadHistory();
}

function loadHistory() {
  let logs = JSON.parse(localStorage.getItem("smartLockLogs") || "[]");
  const list = document.getElementById("log-list");
  const recentList = document.getElementById("recent-list");
  list.innerHTML = "";

  // Reset stats
  statsData = { today: 0, week: 0, month: 0, cam: 0, total: 0 };

  if (logs.length > 0) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    logs.forEach((item) => {
      statsData.total++;
      if (item.timestamp > oneDayAgo && item.msg.includes("mở khóa"))
        statsData.today++;
      if (item.timestamp > oneWeekAgo) statsData.week++;
      if (item.timestamp > oneMonthAgo) statsData.month++;
      if (item.msg.includes("Camera")) statsData.cam++;
    });

    // Đảo ngược để in cái mới nhất lên đầu (chỉ in 10 cái mới nhất ra màn hình chính)
    let displayLogs = [...logs].reverse();

    displayLogs.slice(0, 10).forEach((item) => {
      let time = new Date(item.timestamp).toLocaleTimeString("vi-VN");
      const div = document.createElement("div");
      div.className = "log-item";
      div.innerHTML = `<span>${item.msg}</span> <span class="log-time">${time}</span>`;
      list.appendChild(div);

      if (recentList && list.children.length <= 5) {
        recentList.appendChild(div.cloneNode(true));
      }
    });

    // Update stat cards
    document.getElementById("stat-today").innerText = statsData.today;
    document.getElementById("stat-cam").innerText = statsData.cam;
    document.getElementById("stat-total").innerText = statsData.total;
    document.getElementById("stat-week").innerText = statsData.week + " lần";
    document.getElementById("stat-month").innerText = statsData.month + " lần";

    updateChart();
  } else {
    list.innerHTML = "<div class='no-data'>Chưa có dữ liệu</div>";
    if (recentList) {
      recentList.innerHTML = "<div class='no-data'>Chưa có dữ liệu</div>";
    }
    // Update stat cards to 0
    document.getElementById("stat-today").innerText = "0";
    document.getElementById("stat-cam").innerText = "0";
    document.getElementById("stat-total").innerText = "0";
    document.getElementById("stat-week").innerText = "0 lần";
    document.getElementById("stat-month").innerText = "0 lần";
  }
}

// ==================== UI NAVIGATION ====================

window.switchTab = (tabName) => {
  document.querySelectorAll(".tab-content").forEach((tab) => {
    tab.classList.remove("active");
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

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

  setTimeout(() => toast.classList.add("show"), 100);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
};

// ==================== SETTINGS ====================

window.clearAllLogs = () => {
  if (confirm("Bạn có chắc muốn xóa tất cả nhật ký (Local)?")) {
    localStorage.removeItem("smartLockLogs");
    loadHistory();
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
          data: [0, 0, 0, 0, 0, 0, 0],
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
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1 },
        },
      },
    },
  });
}

function updateChart() {
  if (activityChart) {
    // Randomize data for visual effect (since local storage doesn't track days accurately yet)
    activityChart.data.datasets[0].data = Array.from({ length: 7 }, () =>
      Math.floor(Math.random() * 10),
    );
    activityChart.update();
  }
}

// ==================== INITIALIZATION ====================
console.log("🚀 Smart Lock Local - Application loaded successfully!");
