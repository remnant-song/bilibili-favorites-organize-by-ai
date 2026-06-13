/**
 * popup.js - 弹窗逻辑
 * 处理配置保存和向 content script 发送指令
 */

// ================= DOM 元素引用 =================
const apiKeyInput = document.getElementById('apiKey');
const apiUrlInput = document.getElementById('apiUrl');
const modelInput = document.getElementById('model');
const batchSizeInput = document.getElementById('batchSize');
const maxRetriesInput = document.getElementById('maxRetries');
const customPromptInput = document.getElementById('customPrompt');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const saveStatus = document.getElementById('saveStatus');
const startBtn = document.getElementById('startBtn');
const modeRadios = document.querySelectorAll('input[name="mode"]');

// ================= 配置加载 =================
/**
 * 页面加载时从 storage 读取已有配置
 */
function loadConfig() {
  chrome.runtime.sendMessage({ action: 'getConfig' }, (config) => {
    if (config) {
      apiKeyInput.value = config.apiKey || '';
      apiUrlInput.value = config.apiUrl || 'https://api.deepseek.com/v1/chat/completions';
      modelInput.value = config.model || 'deepseek-v4-flash';
      batchSizeInput.value = config.batchSize || 200;
      maxRetriesInput.value = config.maxRetries || 3;
    }
  });
}

// ================= 配置保存 =================
/**
 * 保存配置到 chrome.storage.local
 */
function saveConfig() {
  const config = {
    apiKey: apiKeyInput.value.trim(),
    apiUrl: apiUrlInput.value.trim(),
    model: modelInput.value.trim(),
    batchSize: parseInt(batchSizeInput.value) || 200,
    maxRetries: parseInt(maxRetriesInput.value) || 3
  };

  // 验证必填项
  if (!config.apiKey) {
    saveStatus.textContent = '请填写 API Key';
    saveStatus.style.color = '#ff6b6b';
    return;
  }

  chrome.runtime.sendMessage({ action: 'saveConfig', config }, (response) => {
    if (response && response.success) {
      saveStatus.textContent = '已保存';
      saveStatus.style.color = '#4CAF50';
      setTimeout(() => {
        saveStatus.textContent = '';
      }, 2000);
    }
  });
}

// ================= 开始整理 =================
/**
 * 向当前活动标签页的 content script 发送开始整理指令
 */
function startOrganize() {
  // 获取选中的模式
  const modeRadio = document.querySelector('input[name="mode"]:checked');
  const isCopyMode = modeRadio ? modeRadio.value === 'copy' : false;

  // 构造配置对象传递给 content script
  const config = {
    customPrompt: customPromptInput.value.trim(),
    isCopyMode: isCopyMode
  };

  // 获取当前活动标签页
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0 || !tabs[0].id) {
      alert('无法获取当前页面信息，请确保在 B 站收藏夹页面中点击此扩展');
      return;
    }

    const currentTab = tabs[0];

    // 检查是否在 B 站收藏夹页面
    if (!currentTab.url || !currentTab.url.includes('space.bilibili.com')) {
      alert('请在 B 站收藏夹页面中使用此扩展！');
      return;
    }

    // 发送消息给 content script
    chrome.tabs.sendMessage(currentTab.id, {
      action: 'startOrganize',
      config: config
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('发送消息失败:', chrome.runtime.lastError);
        alert('扩展未能连接到页面，请刷新 B 站收藏夹页面后重试！');
      } else if (response && response.success) {
        // content script 开始处理，弹窗可以关闭了
        console.log('整理任务已启动');
      } else {
        alert(response?.error || '启动失败，请检查控制台');
      }
    });
  });
}

// ================= 事件绑定 =================

// 页面加载时读取配置
document.addEventListener('DOMContentLoaded', loadConfig);

// 保存配置按钮
saveConfigBtn.addEventListener('click', saveConfig);

// 开始整理按钮
startBtn.addEventListener('click', () => {
  // 先保存配置
  if (apiKeyInput.value.trim()) {
    saveConfig();
  }
  // 延迟执行开始，确保配置先保存
  setTimeout(startOrganize, 100);
});

// 模式切换时更新卡片 active 状态
modeRadios.forEach(radio => {
  radio.addEventListener('change', function() {
    document.querySelectorAll('.mode-card').forEach(card => {
      card.classList.toggle('active', card.dataset.mode === this.value);
    });
  });
});

// 监听来自 background 的响应（用于调试）
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'configUpdated') {
    loadConfig(); // 重新加载配置
  }
});

console.log('B站 AI 收藏夹整理 - Popup 脚本已加载');
