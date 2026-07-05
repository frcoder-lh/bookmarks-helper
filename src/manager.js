let bookmarkTreeRaw = [];
let allBookmarks = [];
let detectedDeadLinks = []; // 缓存当前诊断出的死链节点信息

document.addEventListener('DOMContentLoaded', () => {
    initI18n(); // 优先初始化静态多语言界面
    loadBookmarks();
    document.getElementById('search-input').addEventListener('input', filterAndRender);
    document.getElementById('clean-dup').addEventListener('click', mergeAndCleanFolders);
    document.getElementById('check-dead').addEventListener('click', checkDeadLinksWithConcurrency);

    // 弹窗相关事件绑定
    document.getElementById('modal-cancel').addEventListener('click', () => { document.getElementById('dead-modal').style.display = 'none'; });
    document.getElementById('toggle-all-dead').addEventListener('change', toggleSelectAllDead);
    document.getElementById('modal-submit').addEventListener('click', executeDeadDeletion);
});

// 新增：自动翻译前端页面DOM的核心函数
function initI18n() {
    // 1. 翻译普通的纯文本
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const msg = chrome.i18n.getMessage(key);
        if (msg) el.textContent = msg;
    });
    // 2. 翻译带HTML标签的文本
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html');
        const arg1 = el.getAttribute('data-arg1') || '';
        const msg = chrome.i18n.getMessage(key, [arg1]);
        if (msg) el.innerHTML = msg;
    });
    // 3. 翻译输入框的占位符
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const msg = chrome.i18n.getMessage(key);
        if (msg) el.placeholder = msg;
    });
}

// 1. 读取数据
function loadBookmarks() {
    chrome.bookmarks.getTree((treeNodes) => {
        bookmarkTreeRaw = treeNodes;
        allBookmarks = [];
        flattenBookmarks(treeNodes, "");
        filterAndRender();
        updateStatusBar(chrome.i18n.getMessage("status_loaded", [allBookmarks.length.toString()]));
        hideProgress();
    });
}

function flattenBookmarks(nodes, currentPath) {
    for (let node of nodes) {
        if (node.children) {
            let nextPath = currentPath ? `${currentPath} / ${node.title}` : node.title;
            if (node.id === "0" || node.id === "1" || node.id === "2") {
                nextPath = node.title || "";
            }
            flattenBookmarks(node.children, nextPath);
        } else if (node.url) {
            allBookmarks.push({
                id: node.id,
                title: node.title || chrome.i18n.getMessage("title_none"),
                url: node.url,
                path: currentPath || chrome.i18n.getMessage("path_root"),
                dateAdded: node.dateAdded || null,
                dateLastUsed: node.dateLastUsed || null,
                isDead: false // 新增死链状态字段
            });
        }
    }
}

function filterAndRender() {
    const keyword = document.getElementById('search-input').value.toLowerCase().trim();
    const tbody = document.getElementById('bookmark-tbody');
    tbody.innerHTML = '';

    const filtered = allBookmarks.filter(item => {
        return item.title.toLowerCase().includes(keyword) || item.path.toLowerCase().includes(keyword);
    });

    filtered.forEach(item => {
        const tr = document.createElement('tr');
        if (item.isDead) tr.className = 'dead-row'; // 诊断出的死链在主表中呈现红色高亮
        tr.innerHTML = `
      <td><strong>${escapeHtml(item.title)}</strong></td>
      <td><span class="path-tag">${escapeHtml(item.path)}</span></td>
      <td><a class="url-link" href="${item.url}" target="_blank">${escapeHtml(item.url)}</a></td>
      <td class="time-text">${formatDate(item.dateAdded)}</td>
      <td class="time-text">${formatDate(item.dateLastUsed || item.dateAdded)}</td>
    `;
        tbody.appendChild(tr);
    });
}

// 2. 同名文件夹合并去重
async function mergeAndCleanFolders() {
    updateStatusBar(chrome.i18n.getMessage("status_scanning"));
    let folderMap = {};

    function scanFolders(nodes, currentPath) {
        for (let node of nodes) {
            if (node.children) {
                let nextPath = currentPath ? `${currentPath} / ${node.title}` : node.title;
                if (node.id === "0" || node.id === "1" || node.id === "2") {
                    nextPath = node.title || "";
                }
                if (nextPath) {
                    if (!folderMap[nextPath]) folderMap[nextPath] = [];
                    folderMap[nextPath].push(node);
                }
                scanFolders(node.children, nextPath);
            }
        }
    }

    scanFolders(bookmarkTreeRaw, "");
    let targetPaths = Object.keys(folderMap).filter(path => folderMap[path].length > 1);

    if (targetPaths.length === 0) {
        await deduplicateUrlsOnly();
        return;
    }

    if (!confirm(chrome.i18n.getMessage("confirm_merge", [targetPaths.length.toString()]))) {
        return;
    }

    showProgress();
    let totalSteps = targetPaths.length;
    let currentStep = 0;

    for (let path of targetPaths) {
        currentStep++;
        let progressPercentage = Math.round((currentStep / totalSteps) * 100);
        updateProgressBar(progressPercentage);
        updateStatusBar(chrome.i18n.getMessage("status_merging", [progressPercentage.toString(), path]));

        let instances = folderMap[path];
        let firstInstance = instances[0];

        for (let i = 1; i < instances.length; i++) {
            let duplicateFolder = instances[i];
            if (duplicateFolder.children && duplicateFolder.children.length > 0) {
                let childrenToMove = [...duplicateFolder.children];
                for (let child of childrenToMove) {
                    await new Promise(resolve => chrome.bookmarks.move(child.id, { parentId: firstInstance.id }, resolve));
                }
            }
            await new Promise(resolve => chrome.bookmarks.remove(duplicateFolder.id, resolve));
        }
    }

    updateStatusBar(chrome.i18n.getMessage("status_cleaning"));
    await deduplicateUrlsOnly(true);
}

async function deduplicateUrlsOnly(isSilent = false) {
    const latestTree = await new Promise(resolve => chrome.bookmarks.getTree(resolve));
    allBookmarks = [];
    flattenBookmarks(latestTree, "");

    const seen = new Set();
    let dupCount = 0;
    let promises = [];

    allBookmarks.forEach(item => {
        const uniqueKey = `${item.path}|||${item.url}`;
        if (seen.has(uniqueKey)) {
            dupCount++;
            promises.push(new Promise(resolve => chrome.bookmarks.remove(item.id, resolve)));
        } else {
            seen.add(uniqueKey);
        }
    });

    if (dupCount > 0) {
        await Promise.all(promises);
    }

    hideProgress();
    if (isSilent) {
        alert(chrome.i18n.getMessage("alert_merge_success", [dupCount.toString()]));
    } else {
        alert(chrome.i18n.getMessage("alert_clean_success", [dupCount.toString()]));
    }
    loadBookmarks();
}

// 3. 高并发网络检测死链
async function checkDeadLinksWithConcurrency() {
    if (!confirm(chrome.i18n.getMessage("alert_confirm_dead"))) return;

    showProgress();
    detectedDeadLinks = [];
    let checkedCount = 0;
    const total = allBookmarks.length;

    const CONCURRENCY_LIMIT = 10;
    const pool = [];

    const filterTasks = allBookmarks.filter(item => {
        return !(item.url.startsWith('chrome://') || item.url.startsWith('edge://') || item.url.startsWith('about:'));
    });

    const taskTotal = filterTasks.length;

    for (let item of filterTasks) {
        const taskPromise = (async (bookmarkItem) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);

                await fetch(bookmarkItem.url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
                clearTimeout(timeoutId);
            } catch (error) {
                bookmarkItem.isDead = true;
                detectedDeadLinks.push(bookmarkItem);
            } finally {
                checkedCount++;
                let percent = Math.round((checkedCount / taskTotal) * 100);
                updateProgressBar(percent);
                updateStatusBar(chrome.i18n.getMessage("status_diagnosing", [checkedCount.toString(), taskTotal.toString(), detectedDeadLinks.length.toString()]));
            }
        })(item);

        pool.push(taskPromise);

        if (pool.length >= CONCURRENCY_LIMIT) {
            await Promise.race(pool);
            for (let i = pool.length - 1; i >= 0; i--) {
                if (await Promise.all([pool[i]])) {
                    pool.splice(i, 1);
                    break;
                }
            }
        }
    }

    await Promise.all(pool);
    hideProgress();
    filterAndRender();

    if (detectedDeadLinks.length === 0) {
        alert(chrome.i18n.getMessage("alert_dead_none"));
        updateStatusBar(chrome.i18n.getMessage("status_dead_none"));
    } else {
        updateStatusBar(chrome.i18n.getMessage("status_dead_found", [detectedDeadLinks.length.toString()]));
        openDeadConfirmModal();
    }
}

// 4. 死链弹窗交互控制
function openDeadConfirmModal() {
    const container = document.getElementById('dead-list-container');
    container.innerHTML = '';

    detectedDeadLinks.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'dead-item-check';
        itemDiv.innerHTML = `
      <input type="checkbox" class="dead-select-cb" data-id="${item.id}" checked>
      <div>
        <strong>${escapeHtml(item.title)}</strong> <span style="color:#868e96; font-size:11px;">(${escapeHtml(item.path)})</span><br/>
        <span style="color:#e03131; font-size:12px; word-break:break-all;">${escapeHtml(item.url)}</span>
      </div>
    `;
        container.appendChild(itemDiv);
    });

    document.getElementById('dead-modal').style.display = 'flex';
    refreshSelectedCount();

    const cbs = document.querySelectorAll('.dead-select-cb');
    cbs.forEach(cb => cb.addEventListener('change', refreshSelectedCount));
}

function toggleSelectAllDead() {
    const isChecked = document.getElementById('toggle-all-dead').checked;
    const cbs = document.querySelectorAll('.dead-select-cb');
    cbs.forEach(cb => cb.checked = isChecked);
    refreshSelectedCount();
}

function refreshSelectedCount() {
    const checkedCount = document.querySelectorAll('.dead-select-cb:checked').length;
    // 动态更新确定按钮内部的传参语言文本
    const btnDelText = document.getElementById('btn-del-text');
    btnDelText.setAttribute('data-arg1', checkedCount.toString());
    const msg = chrome.i18n.getMessage("btn_confirm_del", [checkedCount.toString()]);
    if (msg) btnDelText.innerHTML = msg;
}

// 5. 执行用户勾选的死链删除
async function executeDeadDeletion() {
    const checkedBoxes = document.querySelectorAll('.dead-select-cb:checked');
    if (checkedBoxes.length === 0) {
        alert(chrome.i18n.getMessage("alert_no_select"));
        return;
    }

    if (!confirm(chrome.i18n.getMessage("alert_confirm_del_final", [checkedBoxes.length.toString()]))) {
        return;
    }

    updateStatusBar(chrome.i18n.getMessage("status_deleting"));
    document.getElementById('dead-modal').style.display = 'none';

    let delPromises = [];
    checkedBoxes.forEach(cb => {
        const bookmarkId = cb.getAttribute('data-id');
        delPromises.push(new Promise(resolve => chrome.bookmarks.remove(bookmarkId, resolve)));
    });

    await Promise.all(delPromises);
    alert(chrome.i18n.getMessage("alert_del_success", [checkedBoxes.length.toString()]));
    loadBookmarks();
}

// 界面辅助工具函数
function showProgress() { document.getElementById('progress-box').style.display = 'block'; updateProgressBar(0); }
function hideProgress() { document.getElementById('progress-box').style.display = 'none'; }
function updateProgressBar(percentage) { document.getElementById('progress-indicator').style.width = percentage + '%'; }
function updateStatusBar(text) { document.getElementById('status-text').innerText = text; }
function escapeHtml(str) { return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function formatDate(timestamp) {
    if (!timestamp) return "-";
    const date = new Date(timestamp);
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, '0') + "-" + String(date.getDate()).padStart(2, '0') + " " + String(date.getHours()).padStart(2, '0') + ":" + String(date.getMinutes()).padStart(2, '0') + ":" + String(date.getSeconds()).padStart(2, '0');
}