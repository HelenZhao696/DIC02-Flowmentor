// ===============================
// DOM 元素（核心依赖）
// ===============================
const videoElement = document.getElementById("video");
const canvasElement = document.getElementById("canvas");
const canvasCtx = canvasElement.getContext("2d");
const statusBox = document.getElementById("statusBox"); // 新增：状态提示框

// ===============================
// 全局状态（供后续对接AI API使用）
// ===============================
let studentState = {
  emotion: "neutral",    // face-api识别的主导情绪
  attention: "focused",  // 注意力检测结果
  mentalStatus: "focused"// 情绪+注意力映射的心理状态
};

// ===============================
// 注意力检测辅助变量
// ===============================
let distractedFrames = 0;
let blinkTimes = [];
let lastBlinkTime = 0;
let lastGaze = 0;

// ===============================
// 工具函数
// ===============================
// 计算两点之间的欧几里得距离（用于眨眼检测）
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 新增：更新页面状态提示
function updateStatus(text) {
  statusBox.innerText = text;
}

// ===============================
// face-api 表情识别（修复模型加载路径为CDN）
// ===============================
async function loadEmotionModel() {
  updateStatus("加载表情识别模型中...");
  try {
    const MODEL_URL = 'models'; // Simplified path
    
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
    
    updateStatus("表情识别模型加载完成 ✅");
    console.log("face-api 表情识别模型加载完成");
    return true; // <-- Added success return
  } catch (e) {
    updateStatus("表情模型加载失败 ❌");
    console.error("🚨 真正的网络错误在这里：", e); // Makes the real error obvious
    return false; // <-- Added failure return
  }
}
function checkModelsLoaded() {
  // Check the boolean .isLoaded property for both networks you are using
  const isDetectorLoaded = faceapi.nets.tinyFaceDetector.isLoaded;
  const isExpressionLoaded = faceapi.nets.faceExpressionNet.isLoaded;

  console.log(`Tiny Face Detector Loaded: ${isDetectorLoaded}`);
  console.log(`Face Expression Net Loaded: ${isExpressionLoaded}`);

  if (isDetectorLoaded && isExpressionLoaded) {
    console.log("✅ Success: All required models are fully loaded into memory!");
    return true;
  } else {
    console.error("❌ Error: Models failed to load. The browser likely blocked the files or the path is wrong.");
    return false;
  }
}
async function detectEmotion() {
  try {
    const detection = await faceapi
      .detectSingleFace(videoElement, new faceapi.TinyFaceDetectorOptions())
      .withFaceExpressions();

    if (!detection) {
      studentState.emotion = "neutral";
      return;
    }

    const expressions = detection.expressions;
    // 计算分值最高的主导情绪
    const dominantEmotion = Object.keys(expressions).reduce((a, b) => 
      expressions[a] > expressions[b] ? a : b
    );

    studentState.emotion = dominantEmotion;
    // 新增：更新状态框显示情绪
    statusBox.innerText = `情绪：${dominantEmotion} | 注意力：${studentState.attention}`;
  } catch (e) {
    console.error("表情检测错误：", e);
  }
}

// 每2秒检测一次情绪
setInterval(detectEmotion, 2000);

// ===============================
// MediaPipe FaceMesh 配置
// ===============================
// Change your FaceMesh config to this:
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` 
  // Note: MediaPipe is a rare exception where Chrome sometimes allows the dynamic WebAssembly 
  // fetch, but if it blocks it, you will need to download the .wasm files locally too. 
  // Leave it like this for the first test!
});
faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});

// ===============================
// 心理状态映射（保留，供后续AI API调用）
// ===============================
function updateMentalStatus() {
  if (studentState.attention === "distracted") {
    studentState.mentalStatus = "lost_focus";
    return;
  }

  const emotionToMentalMap = {
    angry: "struggling",
    sad: "fatigued",
    fearful: "anxious",
    disgusted: "frustrated",
    neutral: "focused",
    happy: "engaged",
    surprised: "engaged"
  };

  studentState.mentalStatus = emotionToMentalMap[studentState.emotion] || "focused";
  console.log("更新后的学生状态：", studentState);
}

// ===============================
// FaceMesh 结果处理（注意力检测+Canvas绘制）
// ===============================
faceMesh.onResults((results) => {
  // 1. 清空画布
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  // 2. 保存当前状态并【水平翻转】画布（仅针对视频和网格）
  canvasCtx.save();
  canvasCtx.translate(canvasElement.width, 0);
  canvasCtx.scale(-1, 1);

  // 绘制视频画面
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

  let attentionScore = 0;

  if (results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0];

    // 绘制人脸网格和关键点（它们也会被正确翻转以匹配视频）
    drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, { color: "#C0C0C0", lineWidth: 1 });
    drawLandmarks(canvasCtx, landmarks, { color: "#FF0000", lineWidth: 1 });

    attentionScore++;

    // 视线检测
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const gaze = (leftEye.x + rightEye.x) / 2;
    if (gaze > 0.35 && gaze < 0.65) attentionScore++;

    // 视线移动幅度
    const gazeMovement = Math.abs(gaze - lastGaze);
    lastGaze = gaze;
    if (gazeMovement > 0.1) distractedFrames++;

    // 眨眼检测
    const leftTop = landmarks[159];
    const leftBottom = landmarks[145];
    const rightTop = landmarks[386];
    const rightBottom = landmarks[374];
    const EAR = (distance(leftTop, leftBottom) + distance(rightTop, rightBottom)) / 2;

    const blink = EAR < 0.018;
    const now = Date.now();
    if (blink && now - lastBlinkTime > 300) {
      blinkTimes.push(now);
      lastBlinkTime = now;
    }

    // 10秒内眨眼次数
    blinkTimes = blinkTimes.filter(t => now - t < 10000);
    const blinkRate = blinkTimes.length;
    if (blinkRate >= 2 && blinkRate <= 8) attentionScore++;

  } else {
    // 未检测到人脸
    distractedFrames += 5;
  }

  // 3. 关键修改：在绘制文本之前，【恢复】画布的正常方向
  canvasCtx.restore();

  // 更新分心帧数
  if (attentionScore < 2) {
    distractedFrames++;
  } else {
    distractedFrames = Math.max(0, distractedFrames - 1);
  }

  // 4. 绘制文本（现在画布是正的了，文字不会反！）
  if (distractedFrames > 40) {
    studentState.attention = "distracted";
    canvasCtx.font = "30px Arial";
    canvasCtx.fillStyle = "red";
    canvasCtx.fillText("⚠️ Attention drifting!", 40, 60);
    showMessage("⚠️ Your attention seems to be drifting!");
  } else {
    studentState.attention = "focused";
  }

  // 更新状态
  updateMentalStatus();
  statusBox.innerText = `情绪：${studentState.emotion} | 注意力：${studentState.attention}`;
});

// ===============================
// 摄像头初始化
// ===============================
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await faceMesh.send({ image: videoElement });
  },
  width: 640,
  height: 480
});

// ===============================
// 消息提示系统
// ===============================
function showMessage(text) {
  const box = document.createElement("div");
  box.innerText = text;
  box.style.position = "fixed";
  box.style.bottom = "20px";
  box.style.right = "20px";
  box.style.padding = "15px";
  box.style.background = "black";
  box.style.color = "white";
  box.style.borderRadius = "10px";
  box.style.zIndex = 9999; // 确保提示框在最上层

  document.body.appendChild(box);
  // 3秒后移除提示框
  setTimeout(() => {
    box.remove();
  }, 3000);
}

// ===============================
// 启动函数（补充错误处理）
// ===============================
async function init() {
  try {
    updateStatus("初始化系统中...");
    
    // 1. Attempt to load the face-api models
    await loadEmotionModel();
    
    // 2. Run the check!
    const modelsAreReady = checkModelsLoaded();
    
    // If models failed to load, stop the initialization so it doesn't crash later
    if (!modelsAreReady) {
      updateStatus("系统错误：模型未加载");
      return; 
    }

    // 3. Start the camera
    updateStatus("请求摄像头权限...");
    await camera.start();
    
    updateStatus("系统启动完成 ✅ | 情绪：neutral | 注意力：focused");
    console.log("系统初始化完成，开始检测...");
    
    // 4. Start the detection loop
    setInterval(detectEmotion, 2000);

  } catch (e) {
    updateStatus("系统启动失败 ❌：" + e.message);
    console.error("启动错误：", e);
  }
}

// 启动系统
init();