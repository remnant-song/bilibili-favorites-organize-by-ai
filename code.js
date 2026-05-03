// ==UserScript==
// @name         B站 AI 收藏夹自动细化整理 (V8.3 智能重试版)
// @namespace    http://tampermonkey.net/
// @version      8.3.0
// @description  使用 DeepSeek 模型，分批处理，网络问题自动重试，JSON格式错误跳过不中断
// @author       某不知名的根号三 & Gemini
// @match        https://space.bilibili.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // ================= 配置区 =================
    const API_URL = 'https://api.deepseek.com/v1/chat/completions';
    const API_KEY = '你的有效Key'; // 替换为有效 Key
    const MODEL_NAME = 'deepseek-chat';
    const BATCH_SIZE = 200; // 每批处理视频数
    const MAX_RETRIES = 3;  // 每批最大重试次数
    // ==========================================

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function logStatus(msg) {
        console.log(msg);
        const logDiv = document.getElementById('ai-status-log');
        if (logDiv) {
            logDiv.innerHTML += `<div style="margin-top:4px;">➜ ${msg}</div>`;
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    }

    function getBiliData() {
        const midMatch = document.cookie.match(/DedeUserID=([^;]+)/);
        const csrfMatch = document.cookie.match(/bili_jct=([^;]+)/);
        return { mid: midMatch ? midMatch[1] : '', csrf: csrfMatch ? csrfMatch[1] : '' };
    }

    function getSourceMediaId() {
        const params = new URLSearchParams(window.location.search);
        return params.get('fid') || params.get('media_id') || params.get('id');
    }

    function buildFormData(obj) {
        return new URLSearchParams(obj).toString();
    }

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

    async function createFolder(title, biliData) {
        logStatus(`📁 正在新建收藏夹：【${title}】`);
        const url = 'https://api.bilibili.com/x/v3/fav/folder/add';
        const data = buildFormData({ title: title, privacy: 1, csrf: biliData.csrf });
        const res = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data
        }).then(r => r.json());
        if (res.code === 0) return res.data.id;
        throw new Error(`新建失败: ${res.message}`);
    }

    async function moveVideos(sourceMediaId, tarMediaId, resourcesStr, biliData) {
        const url = 'https://api.bilibili.com/x/v3/fav/resource/move';
        const data = buildFormData({
            src_media_id: sourceMediaId, tar_media_id: tarMediaId, mid: biliData.mid,
            resources: resourcesStr, csrf: biliData.csrf
        });
        const res = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data
        }).then(r => r.json());
        if (res.code !== 0) {
            const msg = `移动失败：${res.message} (${resourcesStr.substring(0, 30)}...)`;
            logStatus(`⚠️ ${msg}`);
            console.error(msg);
        }
    }

    // ========== 核心分批处理逻辑 ==========
    let isRunning = false;

    async function startProcess() {
        if (isRunning) {
            logStatus('⏳ 已有整理任务正在进行中，请勿重复点击');
            return;
        }
        isRunning = true;

        const biliData = getBiliData();
        const btn = document.getElementById('ai-start-btn');
        const customPromptInput = document.getElementById('ai-custom-prompt');

        if (!biliData.mid || !biliData.csrf) {
            alert("请确保你在 B 站已登录！");
            isRunning = false;
            return;
        }
        const sourceMediaId = getSourceMediaId();
        if (!sourceMediaId) {
            alert("未能识别当前页面的收藏夹 ID！请确保你在某个具体的收藏夹页面内。");
            isRunning = false;
            return;
        }

        const userRequirement = customPromptInput.value.trim();
        btn.innerText = '🔄 整理中，请看下方日志...';
        btn.disabled = true;
        btn.style.background = '#ccc';
        document.getElementById('ai-status-log').innerHTML = '';

        try {
            // 1. 获取已有收藏夹
            logStatus(`正在获取现有的收藏夹列表...`);
            const existingFoldersMap = await getMyFolders(biliData);
            const existingFolderNames = Object.keys(existingFoldersMap);
            logStatus(`📦 发现 ${existingFolderNames.length} 个已有收藏夹`);

            // 2. 全量抓取视频（增加间隔防风控）
            logStatus(`开始全量抓取当前收藏夹视频...`);
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
                await sleep(1200); // 增加至1.2秒，防风控
            }

            if (allVideos.length === 0) {
                logStatus("⚠️ 当前收藏夹是空的！");
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

                logStatus(`\n📦 开始处理第 ${batchNum}/${totalBatches} 批 (${start+1}~${end}，共 ${batchVideos.length} 个视频)`);

                const videoDataForAI = batchVideos.map(v => ({
                    id: v.id, type: v.type, title: v.title,
                    intro: v.intro ? v.intro.substring(0, 30) : ''
                }));

                const customRuleText = userRequirement
                    ? `\n\n【⭐⭐⭐用户特殊需求 (最高优先级)⭐⭐⭐】\n用户的特别指示是："${userRequirement}"\n请你务必听从！\n⚠️ 致命警告：如果用户的指示中提到了要把视频放入某个分类，请你务必在上面的【已有收藏夹】列表里寻找最匹配的准确名称！如果用户打字简写了（比如用户说“音乐”，但已有的是“我的音乐”），你必须输出已有收藏夹的完整名称“我的音乐”，绝不允许凭空新建近义词分类！`
                    : '';

                const combinedPrompt = `你是一个逻辑极其严密的文件整理专家。我现在需要你帮我把一批 B 站视频分类。
非常重要：用户目前已经建好了以下这些收藏夹：
[ ${existingFolderNames.length > 0 ? existingFolderNames.join(', ') : '暂无'} ]

请你严格按照以下 3 个步骤执行：
【步骤 1：存量强制匹配】
通读所有视频。只要视频内容沾边，就必须一字不差地使用上述【已有收藏夹】的名称作为分类键名。

【步骤 2：谨慎新建】
只有当某几个视频确实与所有“已有收藏夹”都毫不相干时，你才可以创建一个新的涵盖面广的“大类”。绝不为单一视频建新分类，孤立视频请塞入最贴近的已有分类。

【步骤 3：绝无遗漏】
确保列表中的**每一个视频**都被分配到了具体的分类中，绝对不可以遗漏任何一个 ID！${customRuleText}

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
                            logStatus(`⏳ 第 ${batchNum} 批 AI 调用失败，${2*attempt}秒后重试...`);
                            await sleep(2000 * attempt);
                        } else {
                            logStatus(`❌ 第 ${batchNum} 批 AI 调用多次失败，终止后续批次。`);
                        }
                    }
                }

                if (!aiText) {
                    // 重试耗尽，终止整个任务（网络或Key问题）
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

                    // 移动视频
                    let batchProcessed = 0;
                    for (const [categoryName, vids] of Object.entries(aiResult.categories)) {
                        if (!vids || vids.length === 0) continue;

                        let targetFolderId = existingFoldersMap[categoryName];
                        if (!targetFolderId) {
                            targetFolderId = await createFolder(categoryName, biliData);
                            existingFoldersMap[categoryName] = targetFolderId;
                            await sleep(1000);
                        }

                        logStatus(`🚚 正将 ${vids.length} 个视频移入【${categoryName}】...`);
                        const resourcesStr = vids.map(v => `${v.id}:${v.type}`).join(',');
                        await moveVideos(sourceMediaId, targetFolderId, resourcesStr, biliData);
                        batchProcessed += vids.length;
                        await sleep(600);
                    }

                    totalProcessed += batchProcessed;
                    logStatus(`✅ 第 ${batchNum} 批处理完成，本批处理 ${batchProcessed} 个视频`);

                } catch (e) {
                    logStatus(`❌ 第 ${batchNum} 批 AI 返回的 JSON 格式错误: ${e.message}，跳过本批继续下一批。`);
                    console.error("解析失败的 AI 内容:", aiText);
                    // 不终止，继续下一批
                    continue;
                }

                // 批次间隔
                if (i < totalBatches - 1) {
                    logStatus(`⏳ 等待 2 秒后开始下一批...`);
                    await sleep(2000);
                }
            }

            logStatus(`\n🎉 全部整理完成！共处理了 ${totalProcessed} 个视频。请刷新页面！`);
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

    // 封装 AI 请求，只负责成功拿到模型回复文本，其他情况均抛出错误
    function callAI(promptText) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: API_URL,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + API_KEY
                },
                data: JSON.stringify({
                    model: MODEL_NAME,
                    messages: [{ role: "user", content: promptText }],
                    temperature: 0.1,
                    max_tokens: 16000
                }),
                onload: function(response) {
                    if (response.status !== 200) {
                        let errMsg = `API状态码错误: ${response.status}`;
                        try {
                            const errData = JSON.parse(response.responseText);
                            if (errData.error && errData.error.message) {
                                errMsg += ' - ' + errData.error.message;
                            }
                        } catch (e) {}
                        reject(new Error(errMsg));
                        return;
                    }
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.choices && data.choices[0] && data.choices[0].message) {
                            resolve(data.choices[0].message.content);
                        } else {
                            reject(new Error('API响应缺少choices字段'));
                        }
                    } catch (e) {
                        reject(new Error('API响应JSON解析失败'));
                    }
                },
                onerror: function(err) {
                    reject(new Error('网络请求失败'));
                }
            });
        });
    }

    function resetButton(btn) {
        btn.innerText = '🚀 开始深度整理';
        btn.style.background = '#fb7299';
        btn.disabled = false;
        btn.onclick = startProcess;
    }

    // ================= UI 构建区（不变） =================
    function initUI() {
        if (document.getElementById('ai-sort-wrapper')) return;

        const floatBtn = document.createElement('div');
        floatBtn.id = 'ai-float-btn';
        floatBtn.innerHTML = '🤖<br>AI整理';
        floatBtn.style.cssText = 'position:fixed; bottom:30px; left:30px; z-index:9999; background:#fb7299; color:white; width:50px; height:50px; border-radius:25px; display:flex; align-items:center; justify-content:center; text-align:center; font-size:12px; font-weight:bold; cursor:pointer; box-shadow: 0 4px 10px rgba(251, 114, 153, 0.4); transition:0.3s;';

        const panel = document.createElement('div');
        panel.id = 'ai-sort-wrapper';
        panel.style.cssText = 'position:fixed; bottom:30px; left:30px; z-index:10000; width:320px; display:none; flex-direction:column; box-shadow: 0 5px 20px rgba(0,0,0,0.2); border-radius:10px; overflow:hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;';

        panel.innerHTML = `
            <div style="background:#fb7299; color:#fff; padding:12px 15px; font-weight:bold; font-size:15px; display:flex; justify-content:space-between; align-items:center;">
                <span>🤖 AI 收藏夹整理助理 (重试版)</span>
                <span id="ai-close-btn" style="cursor:pointer; font-size:18px; line-height:1;">×</span>
            </div>
            <div style="background:#fff; padding:15px; border:1px solid #eee; border-top:none;">
                <p style="margin:0 0 8px 0; font-size:13px; color:#555;">有什么特定的整理要求吗？(选填)</p>
                <textarea id="ai-custom-prompt" placeholder="例如：\n- 把所有 Vue 相关的放一个文件夹\n- 把时长超过1小时的单独拎出来\n(不填则优先放入已有收藏夹，并由 AI 自由发挥补充分类)" style="width:100%; height:80px; padding:8px; box-sizing:border-box; border:1px solid #ddd; border-radius:6px; font-size:13px; resize:none; margin-bottom:12px; outline:none;"></textarea>
                <button id="ai-start-btn" style="width:100%; padding:10px; background:#fb7299; color:white; border:none; border-radius:6px; font-size:14px; font-weight:bold; cursor:pointer; transition:background 0.2s;">🚀 开始深度整理</button>
                <div id="ai-status-log" style="margin-top:15px; background:#f4f4f4; padding:8px; border-radius:6px; font-size:12px; color:#333; height:160px; overflow-y:auto; word-break:break-all;">
                    等待指令...
                </div>
            </div>
        `;

        document.body.appendChild(floatBtn);
        document.body.appendChild(panel);

        floatBtn.onclick = () => {
            floatBtn.style.display = 'none';
            panel.style.display = 'flex';
        };

        document.getElementById('ai-close-btn').onclick = () => {
            panel.style.display = 'none';
            floatBtn.style.display = 'flex';
        };

        document.getElementById('ai-start-btn').onclick = startProcess;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
