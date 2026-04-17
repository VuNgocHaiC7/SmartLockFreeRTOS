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
let chartLabels = ["", "", "", "", "", "", ""];
let chartCounts = [0, 0, 0, 0, 0, 0, 0];
const FIXED_ESP_BASE_URL = "http://10.157.220.74";
let espBaseUrl = FIXED_ESP_BASE_URL;
let isDiscoveringController = false;
let cameraStatusPollTimer = null;
let historyPollTimer = null;
let isHistorySyncing = false;
let isCameraUiOn = false;
let isFaceAuthRunning = false;
let isFaceStorageLoading = false;
let isAddingFace = false;
let authToken = localStorage.getItem("smartLockAuthToken") || "";
let currentUserRole = localStorage.getItem("smartLockUserRole") || "user";
let currentUsername = localStorage.getItem("smartLockUsername") || "";

// ==================== AUTHENTICATION ====================

function getAuthHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function applyRoleUi() {
  const isAdmin = currentUserRole === "admin";
  const faceAddSection = document.getElementById("face-add-section");
  const faceManageSection = document.getElementById("face-manage-section");
  const dangerZone = document.getElementById("danger-zone");
  const userManageSection = document.getElementById("user-manage-section");

  if (faceAddSection) {
    faceAddSection.classList.toggle("hidden", !isAdmin);
  }
  if (faceManageSection) {
    faceManageSection.classList.toggle("hidden", !isAdmin);
  }
  if (dangerZone) {
    dangerZone.classList.toggle("hidden", !isAdmin);
  }
  if (userManageSection) {
    userManageSection.classList.toggle("hidden", !isAdmin);
  }
}

function setLoginVisualMode(isLoginMode) {
  const container = document.querySelector(".container");
  if (!container) return;
  container.classList.toggle("login-mode", isLoginMode);
}

window.showCenterPopup = (message) => {
  const popup = document.getElementById("center-popup");
  if (!popup) return;

  popup.textContent = message;
  popup.classList.remove("hidden");
  requestAnimationFrame(() => popup.classList.add("show"));

  setTimeout(() => {
    popup.classList.remove("show");
    setTimeout(() => popup.classList.add("hidden"), 220);
  }, 2300);
};

window.handleLogin = () => {
  const username = document.getElementById("username").value.trim();
  const pass = document.getElementById("password").value.trim();

  if (username === "" || pass === "") {
    ui.loginMsg.innerText = "Vui lòng nhập username và mật khẩu!";
    return;
  }

  ui.loginMsg.innerText = "Đang đăng nhập...";

  (async () => {
    try {
      const response = await fetchWithFallback("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: pass }),
      });

      const payload = await response.json();
      if (!payload?.ok || !payload?.token) {
        throw new Error(payload?.error || "Đăng nhập thất bại");
      }

      authToken = payload.token;
      currentUserRole = payload?.user?.role || "user";
      currentUsername = payload?.user?.username || username;

      localStorage.setItem("smartLockAuthToken", authToken);
      localStorage.setItem("smartLockUserRole", currentUserRole);
      localStorage.setItem("smartLockUsername", currentUsername);

      applyRoleUi();
      setLoginVisualMode(false);

      ui.loginScreen.classList.add("hidden");
      ui.dashScreen.classList.remove("hidden");
      ui.statusDot.classList.add("online");
      document.getElementById("user-email").innerText =
        `${currentUsername} (${currentUserRole})`;

      await initLocalController();
      startCameraStatusSync();
      startHistorySync();
      loadHistory();
      initChart();
      if (currentUserRole === "admin") {
        loadFacesStorage();
        loadUserAccounts();
      }
      showToast("Đăng nhập thành công!", "success");
      ui.loginMsg.innerText = "";
    } catch (error) {
      console.error("Login failed:", error);
      const loginErrorText = String(error?.message || "");
      const invalidCreds =
        loginErrorText.includes("Invalid username or password") ||
        loginErrorText.includes('"error":"Invalid username or password"');

      if (invalidCreds) {
        ui.loginMsg.innerText = "Sai username hoặc mật khẩu";
        showCenterPopup("Sai thông tin đăng nhập");
      } else {
        ui.loginMsg.innerText = "Không thể kết nối server đăng nhập";
      }

      showToast("Đăng nhập thất bại", "error");
    }
  })();
};

window.handleLogout = () => {
  stopCameraStatusSync();
  stopHistorySync();
  ui.loginScreen.classList.remove("hidden");
  ui.dashScreen.classList.add("hidden");
  ui.statusDot.classList.remove("online");
  ui.loginMsg.innerText = "";
  authToken = "";
  currentUserRole = "user";
  currentUsername = "";
  localStorage.removeItem("smartLockAuthToken");
  localStorage.removeItem("smartLockUserRole");
  localStorage.removeItem("smartLockUsername");
  applyRoleUi();
  setLoginVisualMode(true);
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
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "";
  }
  const isLikelyLocalIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const isLikelyLanName = host.endsWith(".local");
  if (isLikelyLocalIp || isLikelyLanName) {
    return `http://${host}`;
  }
  return "";
}

function expandControllerCandidates(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    const withDefaultPort = `http://${parsed.hostname}`;
    const withApiPort = `http://${parsed.hostname}:8080`;

    // If caller already includes a custom port, keep it as highest priority.
    if (parsed.port) {
      return [baseUrl, withDefaultPort, withApiPort].filter(
        (value, index, arr) => value && arr.indexOf(value) === index,
      );
    }

    return [withDefaultPort, withApiPort];
  } catch {
    return [];
  }
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
  // Locked to one fixed ESP32 endpoint as requested.
  return [FIXED_ESP_BASE_URL];
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
  localStorage.setItem("espBaseUrl", FIXED_ESP_BASE_URL);
  isDiscoveringController = false;
  updateControllerUi();
  return "";
}

async function askUserForControllerBase() {
  const suggested = localStorage.getItem("espBaseUrl") || "";
  const input = window.prompt(
    "Khong tim thay ESP32 tu dong. Nhap IP/host ESP32 (vd: 192.168.1.88 hoac 192.168.1.88:8080)",
    suggested,
  );

  if (!input) {
    return "";
  }

  const normalized = normalizeControllerInput(input);
  if (!normalized) {
    showToast("Dia chi ESP32 khong hop le", "error");
    return "";
  }

  const candidates = expandControllerCandidates(normalized);
  for (const candidate of candidates) {
    const reachable = await pingController(candidate, 1400);
    if (reachable) {
      espBaseUrl = candidate;
      localStorage.setItem("espBaseUrl", espBaseUrl);
      updateControllerUi();
      return espBaseUrl;
    }
  }

  showToast("Khong ket noi duoc ESP32 voi dia chi vua nhap", "error");
  return "";
}

window.rediscoverController = async () => {
  const found = await discoverControllerBase();
  if (found) {
    await syncCameraStateOnce();
    showToast(`Da ket noi ESP32: ${found}`, "success");
  } else {
    showToast(
      `Khong ket noi duoc ESP32 co dinh ${FIXED_ESP_BASE_URL.replace("http://", "")}`,
      "error",
    );
  }
};

async function initLocalController() {
  espBaseUrl = FIXED_ESP_BASE_URL;
  localStorage.setItem("espBaseUrl", FIXED_ESP_BASE_URL);
  updateControllerUi();

  if (espBaseUrl && (await pingController(espBaseUrl, 900))) {
    return;
  }

  showToast(
    `ESP32 ${FIXED_ESP_BASE_URL.replace("http://", "")} chua san sang`,
    "info",
  );
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

async function syncHistoryOnce() {
  if (isHistorySyncing) return;
  isHistorySyncing = true;
  try {
    await loadHistory();
  } finally {
    isHistorySyncing = false;
  }
}

function startHistorySync() {
  stopHistorySync();
  historyPollTimer = setInterval(() => {
    syncHistoryOnce();
  }, 2500);
  syncHistoryOnce();
}

function stopHistorySync() {
  if (historyPollTimer) {
    clearInterval(historyPollTimer);
    historyPollTimer = null;
  }
}

// ==================== COMMAND CONTROL ====================

async function sendLocalCommand(cmd) {
  if (!espBaseUrl) {
    await initLocalController();
  }

  espBaseUrl = FIXED_ESP_BASE_URL;

  if (!espBaseUrl) {
    showToast("Chua cau hinh ESP32 co dinh", "error");
    throw new Error("ESP32 IP not configured");
  }

  const reachable = await pingController(espBaseUrl, 900);
  if (!reachable) {
    showToast(
      `Mat ket noi ESP32 ${FIXED_ESP_BASE_URL.replace("http://", "")}`,
      "error",
    );
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

function getControllerHost() {
  if (!espBaseUrl) return "";
  try {
    return new URL(espBaseUrl).hostname;
  } catch {
    return "";
  }
}

function getFaceApiCandidates(controllerHost) {
  const query = controllerHost
    ? `?ip=${encodeURIComponent(controllerHost)}`
    : "";
  return [
    `/api/face-check${query}`,
    `http://127.0.0.1:5000/api/face-check${query}`,
    `http://localhost:5000/api/face-check${query}`,
  ];
}

function getServerApiCandidates(pathWithQuery = "") {
  return [
    `${pathWithQuery}`,
    `http://127.0.0.1:5000${pathWithQuery}`,
    `http://localhost:5000${pathWithQuery}`,
  ];
}

function getFacePhotoCandidates(name, photoUrl = "") {
  const encodedName = encodeURIComponent(name);
  const baseCandidates = getServerApiCandidates(
    `/api/face-photo/${encodedName}`,
  );
  const candidates = photoUrl ? [photoUrl, ...baseCandidates] : baseCandidates;
  return candidates.filter(
    (value, index, arr) => value && arr.indexOf(value) === index,
  );
}

async function fetchWithFallback(pathWithQuery, options = {}) {
  const candidates = getServerApiCandidates(pathWithQuery);
  let response = null;
  let lastError = null;
  const requestOptions = {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...getAuthHeaders(),
    },
  };

  for (const endpoint of candidates) {
    try {
      response = await fetch(endpoint, requestOptions);
      if (response.ok) {
        return response;
      }
      const errorText = await response.text();
      lastError = new Error(errorText || `API failed at ${endpoint}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Cannot call API ${pathWithQuery}`);
}

function renderFacesStorage(faces = []) {
  const list = document.getElementById("face-storage-list");
  if (!list) return;

  if (!Array.isArray(faces) || faces.length === 0) {
    list.innerHTML =
      "<div class='no-data'>Chưa có khuôn mặt nào trong kho dữ liệu</div>";
    return;
  }

  list.innerHTML = "";
  faces
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"))
    .forEach((face) => {
      const safeName = String(face.name || "Unknown");
      const photoCandidates = getFacePhotoCandidates(
        safeName,
        face.photo_url || "",
      );
      const photoSrc = photoCandidates[0] || "";
      const fallbackSrc = photoCandidates.slice(1).join("||");
      const item = document.createElement("div");
      item.className = "face-storage-item";
      item.innerHTML = `
        <div class="face-storage-left">
          <img
            class="face-storage-thumb"
            src="${photoSrc}"
            alt="${safeName}"
            loading="lazy"
            data-fallback-src="${fallbackSrc}"
          />
          <div class="face-storage-meta">
            <div class="face-storage-name">${safeName}</div>
            <div class="face-storage-count">${face.image_count || 0} ảnh</div>
          </div>
        </div>
        <button class="btn btn-danger face-delete-btn" data-face-name="${safeName}">
          <i class="fas fa-trash"></i>
          <span>Xóa</span>
        </button>
      `;
      list.appendChild(item);
    });

  list.querySelectorAll(".face-delete-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const name = button.getAttribute("data-face-name") || "";
      if (!name) return;
      await deleteFaceFromStorage(name);
    });
  });

  list.querySelectorAll(".face-storage-thumb").forEach((imageEl) => {
    imageEl.addEventListener("error", () => {
      const fallbackRaw = imageEl.getAttribute("data-fallback-src") || "";
      if (!fallbackRaw) {
        imageEl.classList.add("is-missing");
        return;
      }

      const options = fallbackRaw.split("||").filter(Boolean);
      if (options.length === 0) {
        imageEl.classList.add("is-missing");
        return;
      }

      const nextSrc = options.shift();
      imageEl.setAttribute("data-fallback-src", options.join("||"));
      imageEl.src = nextSrc;
    });
  });
}

async function loadFacesStorage() {
  if (currentUserRole !== "admin") {
    return;
  }

  if (isFaceStorageLoading) return;
  isFaceStorageLoading = true;

  const list = document.getElementById("face-storage-list");
  if (list) {
    list.innerHTML =
      "<div class='loading-text'>Đang tải danh sách khuôn mặt...</div>";
  }

  try {
    const response = await fetchWithFallback("/api/faces", {
      method: "GET",
      cache: "no-store",
    });
    const payload = await response.json();
    renderFacesStorage(payload.faces || []);
  } catch (error) {
    console.error("Load faces storage failed:", error);
    if (list) {
      list.innerHTML =
        "<div class='no-data'>Không tải được danh sách khuôn mặt</div>";
    }
  } finally {
    isFaceStorageLoading = false;
  }
}

async function deleteFaceFromStorage(name) {
  if (currentUserRole !== "admin") {
    showToast("Bạn không có quyền xóa khuôn mặt", "error");
    return;
  }

  const ok = window.confirm(`Bạn có chắc muốn xóa khuôn mặt '${name}'?`);
  if (!ok) return;

  try {
    await fetchWithFallback(`/api/faces/${encodeURIComponent(name)}`, {
      method: "DELETE",
      cache: "no-store",
    });
    showToast(`Đã xóa khuôn mặt ${name}`, "success");
    saveLocalLog(`Xóa khuôn mặt: ${name}`);
    await loadFacesStorage();
  } catch (error) {
    console.error("Delete face failed:", error);
    showToast("Xóa khuôn mặt thất bại", "error");
  }
}

async function addFaceToStorageByName(name) {
  const controllerHost = getControllerHost();
  const captureQuery = controllerHost
    ? `/api/esp32/capture?ip=${encodeURIComponent(controllerHost)}`
    : "/api/esp32/capture";

  const captureResponse = await fetchWithFallback(captureQuery, {
    method: "GET",
    cache: "no-store",
  });
  const capturePayload = await captureResponse.json();

  const imageUrl =
    capturePayload && capturePayload.url ? capturePayload.url : "";
  if (!imageUrl) {
    throw new Error("Capture image URL not found");
  }

  // Keep behavior consistent with keypad D: once capture is done, turn camera off.
  try {
    await sendLocalCommand("CAM_OFF");
  } catch (error) {
    console.warn("Cannot turn camera off after face capture:", error);
  }
  setCameraUiState(false);

  await fetchWithFallback("/api/add-face", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      image_url: imageUrl,
    }),
  });
}

window.addFaceFromEsp32 = async () => {
  if (currentUserRole !== "admin") {
    showToast("Bạn không có quyền thêm khuôn mặt", "error");
    return;
  }

  if (isAddingFace) {
    showToast("Hệ thống đang thêm khuôn mặt, vui lòng chờ", "info");
    return;
  }

  if (!isCameraUiOn) {
    showToast("Vui lòng bật camera trước khi thêm ảnh khuôn mặt", "info");
    return;
  }

  const input = document.getElementById("face-name-input");
  const name = (input?.value || "").trim();
  if (!name) {
    showToast("Vui lòng nhập tên trước khi thêm", "error");
    return;
  }

  isAddingFace = true;
  try {
    showToast("Đang chụp ảnh và thêm khuôn mặt mới...", "info");
    await addFaceToStorageByName(name);
    showToast(`Thêm khuôn mặt ${name} thành công`, "success");
    saveLocalLog(`Thêm khuôn mặt: ${name}`);
    if (input) input.value = "";
    await loadFacesStorage();
  } catch (error) {
    console.error("Add face failed:", error);
    showToast("Thêm khuôn mặt thất bại", "error");
  } finally {
    isAddingFace = false;
  }
};

window.refreshFacesStorage = async () => {
  await loadFacesStorage();
};

function renderUserAccounts(users = []) {
  const list = document.getElementById("users-list");
  if (!list) return;

  if (!Array.isArray(users) || users.length === 0) {
    list.innerHTML = "<div class='no-data'>Chưa có tài khoản nào</div>";
    return;
  }

  list.innerHTML = "";
  users.forEach((user) => {
    const item = document.createElement("div");
    item.className = "user-item";
    const roleLabel = user.role === "admin" ? "Admin" : "User";
    const statusLabel =
      Number(user.is_active) === 1 ? "Đang hoạt động" : "Đang khóa";

    item.innerHTML = `
      <div class="user-meta">
        <div class="user-name">${user.username}</div>
        <div class="user-sub">Vai trò: ${roleLabel} • ${statusLabel}</div>
      </div>
      <div class="user-actions">
        <button class="btn btn-outline btn-small" data-role-id="${user.id}" data-role="${user.role}">
          Đổi role
        </button>
        <button class="btn btn-warning btn-small" data-toggle-id="${user.id}" data-active="${user.is_active}">
          ${Number(user.is_active) === 1 ? "Khóa" : "Mở"}
        </button>
        <button class="btn btn-danger btn-small" data-delete-id="${user.id}">
          Xóa
        </button>
      </div>
    `;

    list.appendChild(item);
  });

  list.querySelectorAll("[data-role-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.getAttribute("data-role-id");
      const currentRole = button.getAttribute("data-role") || "user";
      const nextRole = currentRole === "admin" ? "user" : "admin";
      await updateUserRole(userId, nextRole);
    });
  });

  list.querySelectorAll("[data-toggle-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.getAttribute("data-toggle-id");
      const active = Number(button.getAttribute("data-active")) === 1;
      await setUserStatus(userId, !active);
    });
  });

  list.querySelectorAll("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.getAttribute("data-delete-id");
      await deleteUserAccount(userId);
    });
  });
}

window.loadUserAccounts = async () => {
  if (currentUserRole !== "admin") return;

  const list = document.getElementById("users-list");
  if (list) {
    list.innerHTML =
      "<div class='loading-text'>Đang tải danh sách tài khoản...</div>";
  }

  try {
    const response = await fetchWithFallback("/api/admin/users", {
      method: "GET",
      cache: "no-store",
    });
    const payload = await response.json();
    renderUserAccounts(payload.users || []);
  } catch (error) {
    console.error("Load users failed:", error);
    if (list) {
      list.innerHTML =
        "<div class='no-data'>Không tải được danh sách tài khoản</div>";
    }
  }
};

window.createUserAccount = async () => {
  if (currentUserRole !== "admin") {
    showToast("Bạn không có quyền tạo user", "error");
    return;
  }

  const usernameInput = document.getElementById("new-username-input");
  const passwordInput = document.getElementById("new-password-input");
  const roleSelect = document.getElementById("new-role-select");

  const username = String(usernameInput?.value || "").trim();
  const password = String(passwordInput?.value || "").trim();
  const role = String(roleSelect?.value || "user")
    .trim()
    .toLowerCase();

  if (!username || !password) {
    showToast("Vui lòng nhập username và mật khẩu user mới", "error");
    return;
  }

  try {
    await fetchWithFallback("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role }),
    });

    showToast(`Đã tạo tài khoản ${username}`, "success");
    if (usernameInput) usernameInput.value = "";
    if (passwordInput) passwordInput.value = "";
    if (roleSelect) roleSelect.value = "user";
    await loadUserAccounts();
  } catch (error) {
    console.error("Create user failed:", error);
    showToast("Tạo user thất bại", "error");
  }
};

async function updateUserRole(userId, role) {
  try {
    await fetchWithFallback(
      `/api/admin/users/${encodeURIComponent(userId)}/role`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      },
    );

    showToast("Đã cập nhật role", "success");
    await loadUserAccounts();
  } catch (error) {
    console.error("Update role failed:", error);
    showToast("Không cập nhật được role", "error");
  }
}

async function setUserStatus(userId, isActive) {
  try {
    await fetchWithFallback(
      `/api/admin/users/${encodeURIComponent(userId)}/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive ? 1 : 0 }),
      },
    );

    showToast("Đã cập nhật trạng thái user", "success");
    await loadUserAccounts();
  } catch (error) {
    console.error("Set status failed:", error);
    showToast("Không cập nhật được trạng thái user", "error");
  }
}

async function deleteUserAccount(userId) {
  if (!window.confirm("Bạn có chắc muốn xóa user này?")) {
    return;
  }

  try {
    await fetchWithFallback(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });

    showToast("Đã xóa user", "success");
    await loadUserAccounts();
  } catch (error) {
    console.error("Delete user failed:", error);
    showToast("Không xóa được user", "error");
  }
}

async function runFaceAuthCheck() {
  if (isFaceAuthRunning) {
    showToast("Hệ thống đang kiểm tra khuôn mặt, vui lòng chờ", "info");
    return;
  }

  if (!isCameraUiOn) {
    showToast("Vui lòng bật camera trước khi bấm Face ID", "info");
    return;
  }

  isFaceAuthRunning = true;
  showToast("Đang thực hiện nhận diện khuôn mặt...", "info");

  try {
    const controllerHost = getControllerHost();
    const capturePath = controllerHost
      ? `/api/esp32-capture?ip=${encodeURIComponent(controllerHost)}`
      : "/api/esp32-capture";

    const captureResponse = await fetchWithFallback(capturePath, {
      method: "GET",
      cache: "no-store",
    });
    const frameBlob = await captureResponse.blob();

    // Keep behavior consistent with keypad D: once capture is done, turn camera off.
    try {
      await sendLocalCommand("CAM_OFF");
    } catch (error) {
      console.warn("Cannot turn camera off after Face ID capture:", error);
    }
    setCameraUiState(false);

    const unlockResponse = await fetchWithFallback(
      "/api/face-unlock?source=web_manual&device_id=DOOR-01",
      {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
        },
        body: frameBlob,
      },
    );

    const result = await unlockResponse.json();
    const resultJsonText = JSON.stringify(result);
    console.log("[FaceUnlock] JSON response object:", result);
    console.log("[FaceUnlock] JSON response text:", resultJsonText);
    if (result.recognized) {
      const matchedName = result.name || "unknown";
      showToast(
        `Khuôn mặt trùng khớp với kho dữ liệu (${matchedName})`,
        "success",
      );
    } else {
      showToast("Khuôn mặt không trùng khớp với kho dữ liệu", "error");
    }

    await loadHistory();
  } catch (error) {
    console.error("Face auth failed:", error);
    showToast("Không thể kiểm tra khuôn mặt từ server", "error");
  } finally {
    isFaceAuthRunning = false;
  }
}

window.sendCommand = async (cmd) => {
  if (cmd === "FACE_AUTH") {
    await runFaceAuthCheck();
    return;
  }

  try {
    await sendLocalCommand(cmd);
  } catch (error) {
    console.error("Local command failed:", error);
    showToast("Không gửi được lệnh đến ESP32", "error");
    return;
  }

  if (cmd === "CAM_ON") {
    await applyCameraPreset();
    setCameraUiState(true, { refreshStream: true });
    showToast("📹 Camera đang bật qua Local API", "success");
    saveLocalLog("Bật Camera");
  } else if (cmd === "CAM_OFF") {
    setCameraUiState(false);

    showToast("Camera đã tắt qua Local API", "success");
    saveLocalLog("Tắt Camera");
  } else if (cmd === "UNLOCK") {
    showToast("Đã gửi lệnh mở khóa trực tiếp!", "success");
    await createAccessLog({
      status: "granted",
      recognized_name: "Manual Unlock",
      confidence: 100,
      photo_url: null,
    });
    await loadHistory();
  }
};

// ==================== DATA & STATISTICS ====================

const HANOI_TIMEZONE = "Asia/Ho_Chi_Minh";

function setTextById(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

function toDateSafe(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  // Parse timestamp as Hanoi time for consistent display (GMT+7).
  if (typeof value === "string") {
    const raw = value.trim();
    const normalized = raw.includes(" ") ? raw.replace(" ", "T") : raw;
    const hasTimezone = /Z$|[+\-]\d{2}:\d{2}$/.test(normalized);
    const isoValue = hasTimezone ? normalized : `${normalized}+07:00`;
    const hanoiDate = new Date(isoValue);
    if (!Number.isNaN(hanoiDate.getTime())) {
      return hanoiDate;
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getHistoryTimeDisplay(rawTimestamp) {
  const date = toDateSafe(rawTimestamp);
  if (!date) return "--:--:--";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: HANOI_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function getHistoryDateDisplay(rawTimestamp) {
  const date = toDateSafe(rawTimestamp);
  if (!date) return "--/--/----";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: HANOI_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function getHistoryDateValue(rawTimestamp) {
  const date = toDateSafe(rawTimestamp);
  return date ? date.getTime() : 0;
}

function getHanoiDateKey(rawTimestamp) {
  const date = toDateSafe(rawTimestamp);
  if (!date) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HANOI_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}

function buildActivityChartData(rawTimestamps = []) {
  const bucketMap = new Map();
  const today = new Date();

  const buckets = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));

    const key = getHanoiDateKey(date);
    const label = new Intl.DateTimeFormat("vi-VN", {
      timeZone: HANOI_TIMEZONE,
      day: "2-digit",
      month: "2-digit",
    }).format(date);

    bucketMap.set(key, 0);
    return { key, label };
  });

  rawTimestamps.forEach((rawTimestamp) => {
    const key = getHanoiDateKey(rawTimestamp);
    if (!key || !bucketMap.has(key)) return;
    bucketMap.set(key, (bucketMap.get(key) || 0) + 1);
  });

  chartLabels = buckets.map((bucket) => bucket.label);
  chartCounts = buckets.map((bucket) => bucketMap.get(bucket.key) || 0);
}

function mapServerLogToHistoryItem(log) {
  const status = String(log.status || "unknown").toLowerCase();
  const source = String(log.source || "unknown").toLowerCase();
  const name = String(log.recognized_name || "").trim();
  const confidence = Number(log.confidence || 0);
  const hasName = name && name.toLowerCase() !== "unknown";

  let title = "Hoạt động hệ thống";
  if (source === "web_manual" && name === "Manual Unlock") {
    title = "Mở khóa thủ công";
  } else if (status === "granted" && hasName) {
    title = `Face ID thành công (${name})`;
  } else if (status === "denied") {
    title = hasName ? `Face ID từ chối (${name})` : "Face ID không khớp";
  } else if (status === "granted") {
    title = "Mở khóa thành công";
  }

  const subtitleParts = [];
  if (hasName && name !== "Manual Unlock") {
    subtitleParts.push(`Tên: ${name}`);
  }
  if (confidence > 0 && name !== "Manual Unlock") {
    subtitleParts.push(`Độ tin cậy: ${confidence}%`);
  }

  return {
    title,
    subtitle: subtitleParts.join(" • "),
    timestamp: log.timestamp,
    timeText: getHistoryTimeDisplay(log.timestamp),
    dateText: getHistoryDateDisplay(log.timestamp),
    dateValue: getHistoryDateValue(log.timestamp),
    status,
    photoUrl: log.photo_url || "",
    source,
  };
}

function isRelevantServerHistoryItem(item) {
  if (!item) return false;

  const title = String(item.title || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();

  const isUnlockEvent = title.includes("mở khóa") || title.includes("mo khoa");
  const isFaceEvent = title.includes("face") || source === "esp32_auto";

  return isUnlockEvent || isFaceEvent;
}

function createHistoryNode(item) {
  const div = document.createElement("div");
  div.className = `log-item activity-item ${item.status === "denied" ? "is-denied" : "is-granted"}`;

  const photoHtml = item.photoUrl
    ? `<img class="activity-photo" src="${item.photoUrl}" alt="activity" loading="lazy" />`
    : '<div class="activity-photo-placeholder"><i class="fas fa-user"></i></div>';

  const subtitleHtml = item.subtitle
    ? `<div class="activity-subtitle">${item.subtitle}</div>`
    : "";

  div.innerHTML = `
    <div class="activity-main">
      ${photoHtml}
      <div class="activity-text">
        <div class="activity-title">${item.title}</div>
        ${subtitleHtml}
      </div>
    </div>
    <div class="log-datetime">
      <span class="log-time">${item.timeText}</span>
      <span class="log-date">${item.dateText || ""}</span>
    </div>
  `;

  return div;
}

function renderHistoryFromServer(logs = []) {
  const list = document.getElementById("log-list");
  const recentList = document.getElementById("recent-list");
  if (!list) return;

  list.innerHTML = "";
  if (recentList) recentList.innerHTML = "";

  statsData = { today: 0, week: 0, month: 0, cam: 0, total: 0 };

  const mapped = Array.isArray(logs)
    ? logs
        .map(mapServerLogToHistoryItem)
        .filter(isRelevantServerHistoryItem)
        .sort((a, b) => b.dateValue - a.dateValue)
    : [];

  buildActivityChartData(mapped.map((item) => item.timestamp));

  if (mapped.length === 0) {
    list.innerHTML = "<div class='no-data'>Chưa có dữ liệu</div>";
    if (recentList) {
      recentList.innerHTML = "<div class='no-data'>Chưa có dữ liệu</div>";
    }
    setTextById("stat-today", "0");
    setTextById("stat-cam", "0");
    setTextById("stat-total", "0");
    setTextById("stat-week", "0 lần");
    setTextById("stat-month", "0 lần");
    updateChart();
    return;
  }

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

  mapped.forEach((item, index) => {
    statsData.total++;
    if (item.status === "granted" && item.dateValue > oneDayAgo)
      statsData.today++;
    if (item.dateValue > oneWeekAgo) statsData.week++;
    if (item.dateValue > oneMonthAgo) statsData.month++;
    if (item.source.includes("camera")) statsData.cam++;

    if (index < 12) {
      list.appendChild(createHistoryNode(item));
    }

    if (recentList && index < 8) {
      recentList.appendChild(createHistoryNode(item));
    }
  });

  setTextById("stat-today", statsData.today);
  setTextById("stat-cam", statsData.cam);
  setTextById("stat-total", statsData.total);
  setTextById("stat-week", `${statsData.week} lần`);
  setTextById("stat-month", `${statsData.month} lần`);
  updateChart();
}

async function createAccessLog(payload) {
  try {
    await fetchWithFallback("/api/access-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "DOOR-01",
        status: payload.status || "unknown",
        photo_url: payload.photo_url || null,
        recognized_name: payload.recognized_name || null,
        confidence: payload.confidence || 0,
      }),
    });
  } catch (error) {
    console.warn("createAccessLog failed", error);
  }
}

function saveLocalLog(actionMsg) {
  let logs = JSON.parse(localStorage.getItem("smartLockLogs") || "[]");
  logs.push({ msg: actionMsg, timestamp: Date.now() });

  // Chỉ giữ lại 100 bản ghi gần nhất cho nhẹ bộ nhớ
  if (logs.length > 100) logs.shift();

  localStorage.setItem("smartLockLogs", JSON.stringify(logs));
}

function renderHistoryFromLocalStorage() {
  const logs = JSON.parse(localStorage.getItem("smartLockLogs") || "[]");
  const list = document.getElementById("log-list");
  const recentList = document.getElementById("recent-list");

  if (!list) return;
  list.innerHTML = "";
  if (recentList) recentList.innerHTML = "";

  statsData = { today: 0, week: 0, month: 0, cam: 0, total: 0 };

  const filteredLogs = logs.filter((item) => {
    const msg = String(item.msg || "").toLowerCase();
    return (
      msg.includes("face") || msg.includes("mở khóa") || msg.includes("mo khoa")
    );
  });

  buildActivityChartData(filteredLogs.map((item) => item.timestamp));

  if (filteredLogs.length > 0) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    filteredLogs.forEach((item) => {
      statsData.total++;
      if (
        item.timestamp > oneDayAgo &&
        item.msg.toLowerCase().includes("mở khóa")
      ) {
        statsData.today++;
      }
      if (item.timestamp > oneWeekAgo) statsData.week++;
      if (item.timestamp > oneMonthAgo) statsData.month++;
      statsData.cam = 0;
    });

    let displayLogs = [...filteredLogs].reverse();

    displayLogs.slice(0, 10).forEach((item) => {
      const time = new Intl.DateTimeFormat("vi-VN", {
        timeZone: HANOI_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(item.timestamp));
      const date = new Intl.DateTimeFormat("vi-VN", {
        timeZone: HANOI_TIMEZONE,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(new Date(item.timestamp));
      const div = document.createElement("div");
      div.className = "log-item";
      div.innerHTML = `
        <span>${item.msg}</span>
        <div class="log-datetime">
          <span class="log-time">${time}</span>
          <span class="log-date">${date}</span>
        </div>
      `;
      list.appendChild(div);

      if (recentList && recentList.children.length < 5) {
        recentList.appendChild(div.cloneNode(true));
      }
    });

    setTextById("stat-today", statsData.today);
    setTextById("stat-cam", statsData.cam);
    setTextById("stat-total", statsData.total);
    setTextById("stat-week", statsData.week + " lần");
    setTextById("stat-month", statsData.month + " lần");
    updateChart();
  } else {
    list.innerHTML = "<div class='no-data'>Chưa có dữ liệu</div>";
    if (recentList) {
      recentList.innerHTML = "<div class='no-data'>Chưa có dữ liệu</div>";
    }
    setTextById("stat-today", "0");
    setTextById("stat-cam", "0");
    setTextById("stat-total", "0");
    setTextById("stat-week", "0 lần");
    setTextById("stat-month", "0 lần");
    updateChart();
  }
}

async function loadHistory() {
  try {
    const response = await fetchWithFallback("/api/logs?limit=120", {
      method: "GET",
      cache: "no-store",
    });
    const payload = await response.json();
    renderHistoryFromServer(payload.data || []);
  } catch (error) {
    console.warn("Load history from server failed, fallback local", error);
    renderHistoryFromLocalStorage();
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

  if (tabName === "settings") {
    if (currentUserRole === "admin") {
      loadFacesStorage();
      loadUserAccounts();
    }
  }
};

// ==================== DARK MODE ====================

window.toggleDarkMode = () => {
  document.body.classList.toggle("dark-mode");
  const isDark = document.body.classList.contains("dark-mode");
  const icon = event.target.closest("button").querySelector("i");
  icon.className = isDark ? "fas fa-sun" : "fas fa-moon";
  showToast(isDark ? "Đã bật chế độ tối" : "Đã tắt chế độ tối", "info");
  localStorage.setItem("darkMode", isDark);
};

if (localStorage.getItem("darkMode") === "true") {
  document.body.classList.add("dark-mode");
}

setLoginVisualMode(true);
applyRoleUi();

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
  if (currentUserRole !== "admin") {
    showToast("Bạn không có quyền xóa nhật ký", "error");
    return;
  }

  if (!confirm("Bạn có chắc muốn xóa tất cả nhật ký hoạt động?")) {
    return;
  }

  (async () => {
    localStorage.removeItem("smartLockLogs");

    try {
      await fetchWithFallback("/api/logs", {
        method: "DELETE",
        cache: "no-store",
      });
      showToast("Đã xóa toàn bộ nhật ký hoạt động", "success");
    } catch (error) {
      console.warn("Clear server logs failed:", error);
      showToast("Đã xóa local, nhưng không xóa được nhật ký server", "error");
    }

    await loadHistory();
  })();
};

// ==================== CHART ====================

function initChart() {
  const ctx = document.getElementById("activityChart");
  if (!ctx) return;

  activityChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: "Hoạt động",
          data: chartCounts,
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

  updateChart();
}

function updateChart() {
  if (activityChart) {
    activityChart.data.labels = chartLabels;
    activityChart.data.datasets[0].data = chartCounts;
    activityChart.update();
  }
}

// ==================== INITIALIZATION ====================
console.log("Smart Lock Local - Application loaded successfully!");
