/**
 * background.js - Service Worker (后台服务)
 * 处理 API 请求和消息中继
 * Manifest V3 要求使用 fetch 替代 GM_xmlhttpRequest
 */

// ================= DeepSeek API 配置 =================
// 注意：API Key 应存储在 storage 中，这里仅为默认值
const DEFAULT_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_RETRIES = 3;
// ==========================================

/**
 * 从存储中获取配置
 * @returns {Promise<{apiKey: string, apiUrl: string, model: string, batchSize: number, maxRetries: number}>}
 */
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'apiUrl', 'model', 'batchSize', 'maxRetries'], (result) => {
      resolve({
        apiKey: result.apiKey || '',
        apiUrl: result.apiUrl || DEFAULT_API_URL,
        model: result.model || DEFAULT_MODEL,
        batchSize: result.batchSize || DEFAULT_BATCH_SIZE,
        maxRetries: result.maxRetries || DEFAULT_MAX_RETRIES
      });
    });
  });
}

/**
 * 调用 DeepSeek API
 * @param {string} promptText - 发送给 AI 的提示词
 * @param {string} apiKey - API 密钥
 * @param {string} apiUrl - API 地址
 * @param {string} model - 模型名称
 * @returns {Promise<string>} AI 返回的文本内容
 */
async function callAI(promptText, apiKey, apiUrl, model) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: promptText }],
      temperature: 0.1,
      max_tokens: 16000
    })
  });

  if (response.status !== 200) {
    let errMsg = `API状态码错误: ${response.status}`;
    try {
      const errData = await response.json();
      if (errData.error && errData.error.message) {
        errMsg += ' - ' + errData.error.message;
      }
    } catch (e) {}
    throw new Error(errMsg);
  }

  const data = await response.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  } else {
    throw new Error('API响应缺少choices字段');
  }
}

/**
 * 保存配置
 * @param {Object} config - 配置对象
 */
function saveConfig(config) {
  chrome.storage.local.set(config, () => {
    console.log('配置已保存:', config);
  });
}

// ================= 消息监听器 =================
// 处理来自 content.js 和 popup.js 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;

  // 保存配置
  if (action === 'saveConfig') {
    saveConfig(request.config);
    sendResponse({ success: true });
    return true;
  }

  // 获取配置
  if (action === 'getConfig') {
    getConfig().then(config => sendResponse(config));
    return true;
  }

  // 调用 AI（由 content script 请求）
  if (action === 'callAI') {
    getConfig().then(async (config) => {
      try {
        const result = await callAI(
          request.prompt,
          config.apiKey,
          config.apiUrl,
          config.model
        );
        sendResponse({ success: true, data: result });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    });
    return true;
  }

  // 获取配置中的批次大小和重试次数（用于 content script 的批处理逻辑）
  if (action === 'getBatchConfig') {
    getConfig().then(config => {
      sendResponse({
        batchSize: config.batchSize,
        maxRetries: config.maxRetries
      });
    });
    return true;
  }
});

console.log('B站 AI 收藏夹整理扩展 - Service Worker 已启动');
