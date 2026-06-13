/**
 * content.js - 内容脚本
 * 注入到 B 站收藏夹页面执行实际整理操作
 * 与 original code.js 功能相同，但适配 Manifest V3 架构
 */

// ================= 等待时间工具 =================
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= 日志输出 =================
function logStatus(msg) {
  console.log('[AI整理]', msg);
  const logDiv = document.getElementById('ai-status-log');
  if (logDiv) {
    logDiv.innerHTML += `<div style="margin-top:4px;">➜ ${msg}</div>`;
    logDiv.scrollTop = logDiv.scrollHeight;
  }
}

// ================= 获取 B 站用户数据 =================
function getBiliData() {
  const midMatch = document.cookie.match(/DedeUserID=([^;]+)/);
  const csrfMatch = document.cookie.match(/bili_jct=([^;]+)/);
  return { mid: midMatch ? midMatch[1] : '', csrf: csrfMatch ? csrfMatch[1] : '' };
}

// ================= 获取当前收藏夹 ID =================
function getSourceMediaId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('fid') || params.get('media_id') || params.get('id');
}

// ================= 构建表单数据 =================
function buildFormData(obj) {
  return new URLSearchParams(obj).toString();
}

// ================= 获取已有收藏夹列表 =================
async function getMyFolders(biliData) {
  const url = `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${biliData.mid}`;
  const res = await fetch(url, { credentials: 'include' }).then(r => r.json());
  if (res.code === 0 && res.data && res.data.list) {
    const folderMap = {};
    res.data.list.forEach(f => {
      if (f.title !== '默认收藏夹') folderMap[f.title] = f.id;
    });
    return folderMap;
  }
  return {};
}

// ================= 新建收藏夹 =================
async function createFolder(title, biliData) {
  logStatus(`📁 正在新建收藏夹：【${title}】`);
  const url = 'https://api.bilibili.com/x/v3/fav/folder/add';
  const data = buildFormData({ title: title, privacy: 1, csrf: biliData.csrf });
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data
  }).then(r => r.json());
  if (res.code === 0) return res.data.id;
  throw new Error(`新建失败: ${res.message}`);
}

// ================= 移动视频到目标收藏夹 =================
async function moveVideos(sourceMediaId, tarMediaId, resourcesStr, biliData) {
  const url = 'https://api.bilibili.com/x/v3/fav/resource/move';
  const data = buildFormData({
    src_media_id: sourceMediaId,
    tar_media_id: tarMediaId,
    mid: biliData.mid,
    resources: resourcesStr,
    csrf: biliData.csrf
  });
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data
  }).then(r => r.json());
  if (res.code !== 0) {
    const msg = `移动失败：${res.message} (${resourcesStr.substring(0, 30)}...)`;
    logStatus(`⚠️ ${msg}`);
    console.error(msg);
  }
}

// ================= 复制视频到目标收藏夹 =================
// 复制模式：B站支持一个视频归属多个收藏夹
// 复制后视频仍保留在源收藏夹中，实现多收藏夹归属
async function copyVideos(sourceMediaId, tarMediaId, resourcesStr, biliData) {
  const url = 'https://api.bilibili.com/x/v3/fav/resource/copy';
  const data = buildFormData({
    src_media_id: sourceMediaId,
    tar_media_id: tarMediaId,
    mid: biliData.mid,
    resources: resourcesStr,
    platform: 'web',
    csrf: biliData.csrf
  });
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data
  }).then(r => r.json());
  if (res.code !== 0) {
    const msg = `复制失败：${res.message} (${resourcesStr.substring(0, 30)}...)`;
    logStatus(`⚠️ ${msg}`);
    console.error(msg);
  }
}

// ================= 调用 AI（通过 background service worker） =================
/**
 * 调用 background script 中的 AI 接口
 * @param {string} promptText - 提示词
 * @returns {Promise<string>} AI 返回内容
 */
function callAI(promptText) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'callAI', prompt: promptText }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || 'AI 调用失败'));
      }
    });
  });
}

// ================= 获取批处理配置 =================
function getBatchConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getBatchConfig' }, (config) => {
      resolve(config || { batchSize: 200, maxRetries: 3 });
    });
  });
}

// ================= 重置按钮状态 =================
function resetButton(btn) {
  btn.innerText = '🚀 开始深度整理';
  btn.style.background = '#fb7299';
  btn.disabled = false;
  btn.onclick = startProcess;
}

// ================= 核心整理流程 =================
let isRunning = false;

/**
 * 开始整理任务
 * @param {Object} config - 来自 popup 的配置 { customPrompt, isCopyMode }
 */
async function startProcess(config) {
  if (isRunning) {
    logStatus('⏳ 已有整理任务正在进行中，请勿重复点击');
    return;
  }

  // 获取页面元素
  const btn = document.getElementById('ai-start-btn');
  if (!btn) {
    console.error('未找到开始按钮');
    return;
  }

  isRunning = true;
  const biliData = getBiliData();

  // 验证登录状态
  if (!biliData.mid || !biliData.csrf) {
    alert('请确保你在 B 站已登录！');
    isRunning = false;
    return;
  }

  // 获取当前收藏夹 ID
  const sourceMediaId = getSourceMediaId();
  if (!sourceMediaId) {
    alert('未能识别当前页面的收藏夹 ID！请确保你在某个具体的收藏夹页面内。');
    isRunning = false;
    return;
  }

  const { customPrompt, isCopyMode } = config || {};
  logStatus(`当前模式：${isCopyMode ? '📋 复制模式（视频可归属多个收藏夹）' : '🚚 移动模式（每个视频只归入一个收藏夹）'}`);

  // 获取批处理配置
  const batchConfig = await getBatchConfig();
  const BATCH_SIZE = batchConfig.batchSize;
  const MAX_RETRIES = batchConfig.maxRetries;

  // 更新按钮状态
  btn.innerText = '🔄 整理中，请看下方日志...';
  btn.disabled = true;
  btn.style.background = '#ccc';

  // 清空日志
  const logDiv = document.getElementById('ai-status-log');
  if (logDiv) logDiv.innerHTML = '';

  try {
    // 1. 获取已有收藏夹
    logStatus('正在获取现有的收藏夹列表...');
    const existingFoldersMap = await getMyFolders(biliData);
    const existingFolderNames = Object.keys(existingFoldersMap);
    logStatus(`📦 发现 ${existingFolderNames.length} 个已有收藏夹`);

    // 2. 全量抓取视频（增加间隔防风控）
    logStatus('开始全量抓取当前收藏夹视频...');
    let allVideos = [];
    let pn = 1;
    const ps = 20;

    while (true) {
      logStatus(`正在读取第 ${pn} 页...`);
      const listUrl = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${sourceMediaId}&pn=${pn}&ps=${ps}&platform=web`;
      const listRes = await fetch(listUrl, { credentials: 'include' }).then(r => r.json());
      if (listRes.code !== 0) {
        logStatus(`❌ 读取出错: ${listRes.message}`);
        break;
      }
      const videos = (listRes.data && listRes.data.medias) ? listRes.data.medias : [];
      if (videos.length === 0) break;
      allVideos.push(...videos);
      if (videos.length < ps) break;
      pn++;
      await sleep(1200); // 1.2秒防风控
    }

    if (allVideos.length === 0) {
      logStatus('⚠️ 当前收藏夹是空的！');
      resetButton(btn);
      isRunning = false;
      return;
    }

    logStatus(`✅ 读取完毕！共获取到 ${allVideos.length} 个视频。`);

    // 3. 分批处理
    const totalBatches = Math.ceil(allVideos.length / BATCH_SIZE);
    let totalProcessed = 0;

    for (let i = 0; i < totalBatches; i++) {
      const start = i * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, allVideos.length);
      const batchVideos = allVideos.slice(start, end);
      const batchNum = i + 1;

      logStatus(`\n📦 开始处理第 ${batchNum}/${totalBatches} 批 (${start + 1}~${end}，共 ${batchVideos.length} 个视频)`);

      // 构造发送给 AI 的视频数据
      const videoDataForAI = batchVideos.map(v => ({
        id: v.id,
        type: v.type,
        title: v.title,
        intro: v.intro ? v.intro.substring(0, 30) : ''
      }));

      // 用户特殊要求
      const customRuleText = customPrompt
        ? `\n\n【⭐⭐⭐用户特殊需求 (最高优先级)⭐⭐⭐】\n用户的特别指示是："${customPrompt}"\n请你务必听从！\n⚠️ 致命警告：如果用户的指示中提到了要把视频放入某个分类，请你务必在上面的【已有收藏夹】列表里寻找最匹配的准确名称！如果用户打字简写了（比如用户说"音乐"，但已有的是"我的音乐"），你必须输出已有收藏夹的完整名称"我的音乐"，绝不允许凭空新建近义词分类！`
        : '';

      // 复制模式规则
      const modeRuleText = isCopyMode
        ? `\n\n【步骤 4：多分类归属（复制模式专属）】\n当前为复制模式，一个视频如果同时符合多个分类，你应当在多个分类中都放入该视频的 id 和 type。\n例如一个"Vue前端教程"视频，如果同时存在"前端"和"Vue"两个分类，则该视频应同时出现在这两个分类的列表中。\n请不要吝啬，合理地让视频出现在所有沾边的分类中。这是复制模式的核心优势！`
        : '';

      // 组合完整提示词
      const combinedPrompt = `你是一个逻辑极其严密的文件整理专家。我现在需要你帮我把一批 B 站视频分类。
非常重要：用户目前已经建好了以下这些收藏夹：
[ ${existingFolderNames.length > 0 ? existingFolderNames.join(', ') : '暂无'} ]

请你严格按照以下 3 个步骤执行：
【步骤 1：存量强制匹配】
通读所有视频。只要视频内容沾边，就必须一字不差地使用上述【已有收藏夹】的名称作为分类键名。

【步骤 2：谨慎新建】
只有当某几个视频确实与所有"已有收藏夹"都毫不相干时，你才可以创建一个新的涵盖面广的"大类"。绝不为单一视频建新分类，孤立视频请塞入最贴近的已有分类。

【步骤 3：绝无遗漏】
确保列表中的**每一个视频**都被分配到了具体的分类中，绝对不可以遗漏任何一个 ID！${customRuleText}${modeRuleText}

请严格输出合法的纯 JSON 格式数据。包含 "thoughts" 和 "categories" 两个字段。
示例：
{
  "thoughts": "分析发现，视频A符合已有的'游戏实况'分类...",
  "categories": {
    "已有收藏夹准确名字1": [{"id": 111, "type": 2}],
    "新创建的大类名字": [{"id": 222, "type": 2}]
  }
}

以下是待处理的所有视频：
${JSON.stringify(videoDataForAI)}`;

      // --- 重试获取 AI 响应 ---
      let aiText = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          aiText = await callAI(combinedPrompt);
          break; // 成功
        } catch (err) {
          console.error(`第${batchNum}批 AI 调用失败 (尝试 ${attempt}/${MAX_RETRIES}):`, err.message);
          if (attempt < MAX_RETRIES) {
            logStatus(`⏳ 第 ${batchNum} 批 AI 调用失败，${2 * attempt}秒后重试...`);
            await sleep(2000 * attempt);
          } else {
            logStatus(`❌ 第 ${batchNum} 批 AI 调用多次失败，终止后续批次。`);
          }
        }
      }

      if (!aiText) {
        // 重试耗尽，终止整个任务
        break;
      }

      // --- 解析 AI 返回的 JSON ---
      try {
        const content = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
        console.log(`========== 第${batchNum}批 AI 返回原始内容 ==========`);
        console.log(content);
        console.log(`====================================================`);
        logStatus(`📄 已输出第${batchNum}批 AI 原始内容至控制台`);

        const aiResult = JSON.parse(content);
        console.log(`💡 第${batchNum}批 AI 思考过程：`, aiResult.thoughts);
        logStatus(`💡 第${batchNum}批思考完毕！`);

        // 执行移动/复制操作
        let batchProcessed = 0;
        for (const [categoryName, vids] of Object.entries(aiResult.categories)) {
          if (!vids || vids.length === 0) continue;

          let targetFolderId = existingFoldersMap[categoryName];
          if (!targetFolderId) {
            targetFolderId = await createFolder(categoryName, biliData);
            existingFoldersMap[categoryName] = targetFolderId;
            await sleep(1000);
          }

          const actionText = isCopyMode ? '复制到' : '移入';
          const actionEmoji = isCopyMode ? '📋' : '🚚';
          logStatus(`${actionEmoji} 正将 ${vids.length} 个视频${actionText}【${categoryName}】...`);
          const resourcesStr = vids.map(v => `${v.id}:${v.type}`).join(',');

          if (isCopyMode) {
            await copyVideos(sourceMediaId, targetFolderId, resourcesStr, biliData);
          } else {
            await moveVideos(sourceMediaId, targetFolderId, resourcesStr, biliData);
          }

          batchProcessed += vids.length;
          await sleep(600);
        }

        totalProcessed += batchProcessed;
        logStatus(`✅ 第 ${batchNum} 批处理完成，本批处理 ${batchProcessed} 个视频`);

      } catch (e) {
        logStatus(`❌ 第 ${batchNum} 批 AI 返回的 JSON 格式错误: ${e.message}，跳过本批继续下一批。`);
        console.error('解析失败的 AI 内容:', aiText);
        continue;
      }

      // 批次间隔
      if (i < totalBatches - 1) {
        logStatus(`⏳ 等待 2 秒后开始下一批...`);
        await sleep(2000);
      }
    }

    // 完成提示
    const modeFinishText = isCopyMode
      ? `\n🎉 全部整理完成！共执行了 ${totalProcessed} 次复制操作（视频仍保留在当前收藏夹中）。请刷新页面！`
      : `\n🎉 全部整理完成！共处理了 ${totalProcessed} 个视频。请刷新页面！`;
    logStatus(modeFinishText);
    btn.innerText = '✅ 整理完成，点我重置';
    btn.style.background = '#4CAF50';
    btn.disabled = false;
    btn.onclick = () => window.location.reload();

  } catch (error) {
    logStatus(`❌ 发生未知错误，请看 F12 控制台`);
    console.error(error);
    resetButton(btn);
  } finally {
    isRunning = false;
  }
}

// ================= UI 构建 =================
/**
 * 初始化页面上的操作面板
 * 移除自动弹窗，改为在页面上显示可交互的固定面板
 */
function initUI() {
  // 避免重复初始化
  if (document.getElementById('ai-sort-wrapper')) return;

  // 创建主面板
  const panel = document.createElement('div');
  panel.id = 'ai-sort-wrapper';
  panel.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    width: 340px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 5px 20px rgba(0, 0, 0, 0.25);
    border-radius: 12px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: white;
  `;

  panel.innerHTML = `
    <div style="background: linear-gradient(135deg, #fb7299 0%, #ff9dbb 100%); color: #fff; padding: 12px 15px; font-weight: bold; font-size: 15px; display: flex; justify-content: space-between; align-items: center;">
      <span>🤖 AI 收藏夹整理助理</span>
      <span id="ai-close-btn" style="cursor: pointer; font-size: 20px; line-height: 1;">×</span>
    </div>
    <div style="padding: 15px; border: 1px solid #eee; border-top: none;">
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #555;">整理模式：</p>
      <div style="margin-bottom: 6px; font-size: 13px; display: flex; gap: 15px;">
        <label style="cursor: pointer; display: flex; align-items: center; gap: 4px;">
          <input type="radio" name="ai-mode" value="move" checked> 🚚 移动模式
        </label>
        <label style="cursor: pointer; display: flex; align-items: center; gap: 4px;">
          <input type="radio" name="ai-mode" value="copy"> 📋 复制模式
        </label>
      </div>
      <div id="ai-mode-desc" style="margin-bottom: 12px; font-size: 11px; color: #999; padding: 6px; background: #f9f9f9; border-radius: 4px; line-height: 1.5;">
        移动模式：视频从当前收藏夹移入目标分类，每个视频只归入一个收藏夹
      </div>
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #555;">有什么特定的整理要求吗？(选填)</p>
      <textarea id="ai-custom-prompt" placeholder="例如：
- 把所有 Vue 相关的放一个文件夹
- 把时长超过1小时的单独拎出来
(不填则优先放入已有收藏夹，并由 AI 自由发挥补充分类)" style="width: 100%; height: 80px; padding: 8px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; resize: none; margin-bottom: 12px; outline: none;"></textarea>
      <button id="ai-start-btn" style="width: 100%; padding: 10px; background: #fb7299; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: bold; cursor: pointer; transition: background 0.2s;">🚀 开始深度整理</button>
      <div id="ai-status-log" style="margin-top: 15px; background: #f4f4f4; padding: 8px; border-radius: 6px; font-size: 12px; color: #333; height: 180px; overflow-y: auto; word-break: break-all;">
        等待指令...<br>
        💡 提示：请先在插件弹窗中配置 API Key 并保存，然后再点击「开始深度整理」
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  // 关闭按钮功能（隐藏面板）
  document.getElementById('ai-close-btn').onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  };

  // 开始按钮事件
  document.getElementById('ai-start-btn').onclick = () => {
    const customPromptInput = document.getElementById('ai-custom-prompt');
    const modeRadio = document.querySelector('input[name="ai-mode"]:checked');
    const isCopyMode = modeRadio ? modeRadio.value === 'copy' : false;

    startProcess({
      customPrompt: customPromptInput.value.trim(),
      isCopyMode: isCopyMode
    });
  };

  // 模式切换时更新说明
  document.querySelectorAll('input[name="ai-mode"]').forEach(radio => {
    radio.addEventListener('change', function() {
      const desc = document.getElementById('ai-mode-desc');
      if (this.value === 'copy') {
        desc.textContent = '复制模式：视频被复制到所有匹配的分类收藏夹，仍保留在当前收藏夹，一个视频可归入多个收藏夹';
      } else {
        desc.textContent = '移动模式：视频从当前收藏夹移入目标分类，每个视频只归入一个收藏夹';
      }
    });
  });

  logStatus('✅ AI 整理面板已初始化');
}

// ================= 消息监听（接收来自 popup 的指令） =================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startOrganize') {
    // 初始化 UI（如果尚未初始化）
    initUI();

    // 确保面板可见
    const panel = document.getElementById('ai-sort-wrapper');
    if (panel) {
      panel.style.display = 'flex';
    }

    // 从 popup config 中获取参数
    const config = request.config || {};

    // 将配置设置到页面上
    const customPromptInput = document.getElementById('ai-custom-prompt');
    const modeRadios = document.querySelectorAll('input[name="ai-mode"]');

    if (customPromptInput && config.customPrompt !== undefined) {
      customPromptInput.value = config.customPrompt;
    }

    if (config.isCopyMode !== undefined) {
      modeRadios.forEach(radio => {
        radio.checked = radio.value === (config.isCopyMode ? 'copy' : 'move');
      });
      // 更新模式说明
      const desc = document.getElementById('ai-mode-desc');
      if (desc) {
        desc.textContent = config.isCopyMode
          ? '复制模式：视频被复制到所有匹配的分类收藏夹，仍保留在当前收藏夹，一个视频可归入多个收藏夹'
          : '移动模式：视频从当前收藏夹移入目标分类，每个视频只归入一个收藏夹';
      }
    }

    // 开始整理流程
    startProcess(config).then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });

    return true; // 表示异步响应
  }
});

// ================= 初始化 =================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}

console.log('B站 AI 收藏夹整理 - Content Script 已加载');
