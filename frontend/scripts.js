const DailyIntelBriefing = (() => {
  let isResearchActive = false;
  let connectionTimeout = null;
  let conversationHistory = [];
  let isInitialLoad = true; // Flag to track initial page load
  let cookiesEnabled = true; // Flag to track if cookies are enabled
  let allReports = ''; // Store all reports cumulatively
  let currentReport = ''; // Store the current report (will be overwritten)
  let isFirstReport = true; // Flag to track if this is the first report
  let chatContainer = null; // Global reference to chat container
  let lastRequestData = null; // Store the last request data for reconnection
  let currentHistoryId = null; // Current report history id for incremental saving
  let dailyIntelJobs = [];
  let dailyIntelRuns = [];
  let activeIntelRunPoller = null;
  let modelProviders = [];
  let selectedModelProvider = 'openai';

  // Add WebSocket monitoring variables
  let socket = null;
  let connectionStartTime = null;
  let lastActivityTime = null;
  let connectionAttempts = 0;
  let messagesReceived = 0;
  let websocketMonitorInterval = null;
  let dispose_socket = null; // Re-add dispose_socket
  let reconnectAttempts = 0;
  let maxReconnectAttempts = 5;
  let reconnectInterval = 2000; // Start with 2 seconds

  const init = () => {
    initPageMode();

    // Check if cookies are enabled
    checkCookiesEnabled();

    // Load history immediately on page load
    loadConversationHistory();

    // After a short delay, mark initial load as complete
    setTimeout(() => {
      isInitialLoad = false;
    }, 1000);

    // Setup form submission
    document.getElementById('researchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      startResearch();
      return false;
    });

    document.getElementById('saveIntelJobBtn')?.addEventListener('click', saveIntelJob);
    document.getElementById('runIntelJobBtn')?.addEventListener('click', runIntelJobNow);
    document.getElementById('newIntelJobBtn')?.addEventListener('click', resetIntelForm);
    document.getElementById('refreshIntelJobsBtn')?.addEventListener('click', loadIntelJobs);
    document.getElementById('refreshIntelRunsBtn')?.addEventListener('click', loadIntelRuns);
    document.getElementById('saveModelConfigBtn')?.addEventListener('click', saveModelConfig);

    document
      .getElementById('copyToClipboard')
      .addEventListener('click', copyToClipboard)

    // Add event listener for the top copy button
    const topCopyButton = document.getElementById('copyToClipboardTop');
    if (topCopyButton) {
      topCopyButton.addEventListener('click', copyToClipboard);
    }

    // Initialize expand buttons
    initExpandButtons();

    // Initialize history panel functionality
    initHistoryPanel();

    // Initialize WebSocket monitoring panel
    initWebSocketPanel();

    // Keep landing and configuration as separate URL-level pages.
    initLandingNavigation();

    // Initialize MCP functionality
    initMCPSection();

    if (document.body.classList.contains('page-config')) {
      loadModelConfig();
      loadIntelJobs();
      loadIntelRuns();
    }

    // The download bar is now fixed in place with CSS
    // No need to set display property here

    updateState('initial');

    // Initialize research icon to not spinning
    updateResearchIcon(false);

    // Hide loading overlay if it exists
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.classList.add('loading-hidden');
    }
  }

  const initPageMode = () => {
    const isConfigPage = window.location.pathname.replace(/\/+$/, '') === '/config';
    document.body.classList.toggle('page-config', isConfigPage);
    document.body.classList.toggle('page-landing', !isConfigPage);
  }

  // Check if cookies are enabled
  const checkCookiesEnabled = () => {
    try {
      // Try to set a test cookie
      document.cookie = "testcookie=1; path=/";
      const cookieEnabled = document.cookie.indexOf("testcookie") !== -1;

      if (!cookieEnabled) {
        console.warn("Cookies are disabled in this browser");
        cookiesEnabled = false;
        showToast("浏览器 Cookie 已禁用，历史记录将改用 localStorage 保存。", 5000);
      } else {
        // Clean up test cookie
        document.cookie = "testcookie=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        cookiesEnabled = true;
      }

      return cookieEnabled;
    } catch (e) {
      console.error("Error checking cookies:", e);
      cookiesEnabled = false;
      return false;
    }
  }

  const initLandingNavigation = () => {
    const landingStartBtn = document.getElementById('landingStartBtn');

    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }

    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));

    if (landingStartBtn) {
      landingStartBtn.addEventListener('click', (event) => {
        event.preventDefault();
        window.location.assign('/config');
      });
    }
  }

  // Initialize conversation history panel functionality
  const initHistoryPanel = () => {
    // Load history from cookie
    loadConversationHistory();

    // Setup history panel toggle button
    const historyPanelOpenBtn = document.getElementById('historyPanelOpenBtn');
    const historyPanel = document.getElementById('historyPanel');
    const historyPanelToggle = document.getElementById('historyPanelToggle');

    if (historyPanelOpenBtn) {
      historyPanelOpenBtn.addEventListener('click', () => {
        loadConversationHistory(); // Reload history when opening panel
        historyPanel.classList.add('open');
      });
    }

    if (historyPanelToggle) {
      historyPanelToggle.addEventListener('click', () => {
        historyPanel.classList.remove('open');
      });
    }

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      // If the panel is open and the click is outside the panel and not on the toggle button
      if (historyPanel.classList.contains('open') &&
        !historyPanel.contains(e.target) &&
        e.target !== historyPanelOpenBtn &&
        !historyPanelOpenBtn.contains(e.target)) {
        historyPanel.classList.remove('open');
      }
    });

    // Setup search functionality
    const historySearch = document.getElementById('historySearch');
    const historySearchBtn = document.getElementById('historySearchBtn');

    if (historySearch && historySearchBtn) {
      historySearch.addEventListener('input', filterHistoryEntries);
      historySearchBtn.addEventListener('click', () => filterHistoryEntries());
    }

    // Setup sort functionality
    const historySortOrder = document.getElementById('historySortOrder');
    if (historySortOrder) {
      historySortOrder.addEventListener('change', () => {
        sortHistoryEntries(historySortOrder.value);
        renderHistoryEntries();
      });
    }

    // Setup clear history button
    const historyClearBtn = document.getElementById('historyClearBtn');
    if (historyClearBtn) {
      historyClearBtn.addEventListener('click', clearConversationHistory);
    }

    // Add action buttons to history panel
    const historyFilters = document.querySelector('.history-panel-filters');
    if (historyFilters) {
      // Create a container for the buttons
      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'history-actions-container';

      // Add export history button with enhanced styling and tooltip
      const exportBtn = document.createElement('button');
      exportBtn.className = 'history-action-btn';
      exportBtn.title = '导出搜索历史';
      exportBtn.innerHTML = '<i class="fas fa-file-export"></i>';
      exportBtn.addEventListener('click', exportHistory);

      // Add import history button with enhanced styling and tooltip
      const importBtn = document.createElement('button');
      importBtn.className = 'history-action-btn';
      importBtn.title = '导入搜索历史';
      importBtn.innerHTML = '<i class="fas fa-file-import"></i>';
      importBtn.addEventListener('click', triggerImportHistory);

      // Add cookie debug button with enhanced styling and tooltip
      const debugBtn = document.createElement('button');
      debugBtn.className = 'history-action-btn';
      debugBtn.title = '检查搜索历史存储';
      debugBtn.innerHTML = '<i class="fas fa-database"></i>';
      debugBtn.addEventListener('click', checkCookieStatus);

      // Add buttons to container in a logical order
      actionsContainer.appendChild(importBtn);
      actionsContainer.appendChild(exportBtn);
      actionsContainer.appendChild(debugBtn);

      // Create a hidden file input for importing
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.id = 'historyFileInput';
      fileInput.accept = '.json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', handleFileImport);

      // Add container and file input to filters
      historyFilters.appendChild(actionsContainer);
      historyFilters.appendChild(fileInput);
    }

    // Initial render of history entries
    renderHistoryEntries();
  }

  // Initialize WebSocket monitoring panel
  const initWebSocketPanel = () => {
    const websocketPanel = document.getElementById('websocketPanel');
    const websocketPanelOpenBtn = document.getElementById('websocketPanelOpenBtn');
    const websocketPanelToggle = document.getElementById('websocketPanelToggle');

    if (!websocketPanel || !websocketPanelOpenBtn || !websocketPanelToggle) {
      console.error("WebSocket panel elements not found");
      return;
    }

    console.log("Initializing WebSocket panel");

    // Ensure it starts hidden
    websocketPanel.classList.remove('open');

    websocketPanelOpenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Opening WebSocket panel");
      websocketPanel.classList.add('open');
    });

    websocketPanelToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Closing WebSocket panel");
      websocketPanel.classList.remove('open');
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      // If the panel is open and the click is outside the panel and not on the toggle button
      if (websocketPanel.classList.contains('open') &&
        !websocketPanel.contains(e.target) &&
        e.target !== websocketPanelOpenBtn &&
        !websocketPanelOpenBtn.contains(e.target)) {
        websocketPanel.classList.remove('open');
      }
    });

    // Start periodic WebSocket status updates
    startWebSocketMonitoring();
  }

  // Start WebSocket monitoring
  const startWebSocketMonitoring = () => {
    console.log("Starting WebSocket monitoring");

    // Update status immediately
    updateWebSocketStatus();

    // Clear any existing interval
    if (websocketMonitorInterval) {
      clearInterval(websocketMonitorInterval);
    }

    // Update status every 2 seconds
    websocketMonitorInterval = setInterval(updateWebSocketStatus, 2000);
  }

  // Update WebSocket status in the panel
  const updateWebSocketStatus = () => {
    // Only proceed if the necessary elements exist
    const connectionStatusEl = document.getElementById('connectionStatus');
    const connectionIndicatorEl = document.getElementById('connectionIndicator');
    const researchStatusEl = document.getElementById('researchStatus');
    const connectionDurationEl = document.getElementById('connectionDuration');
    const lastActivityEl = document.getElementById('lastActivity');
    const readyStateEl = document.getElementById('readyState');
    const connectionAttemptsEl = document.getElementById('connectionAttempts');
    const messagesReceivedEl = document.getElementById('messagesReceived');
    const currentTaskEl = document.getElementById('currentTask');

    if (!connectionStatusEl || !connectionIndicatorEl) return;

    // Update connection status
    const socketStatus = getSocketStatus();
    connectionStatusEl.textContent = socketStatus.statusText;

    // Update indicator class
    connectionIndicatorEl.className = 'status-indicator';
    connectionIndicatorEl.classList.add(socketStatus.indicatorClass);

    // Update research status
    if (researchStatusEl) {
      researchStatusEl.textContent = isResearchActive ? '进行中' : '未开始';
    }

    // Update connection duration
    if (connectionDurationEl && connectionStartTime) {
      const duration = Math.floor((Date.now() - connectionStartTime) / 1000);
      connectionDurationEl.textContent = formatDuration(duration);
    } else if (connectionDurationEl) {
      connectionDurationEl.textContent = '-';
    }

    // Update last activity
    if (lastActivityEl && lastActivityTime) {
      const elapsed = Math.floor((Date.now() - lastActivityTime) / 1000);
      lastActivityEl.textContent = elapsed < 60 ? `${elapsed} 秒前` : `${formatDuration(elapsed)}前`;
    } else if (lastActivityEl) {
      lastActivityEl.textContent = '-';
    }

    // Update ReadyState
    if (readyStateEl && socket) {
      readyStateEl.textContent = getReadyStateText(socket.readyState);
    } else if (readyStateEl) {
      readyStateEl.textContent = '-';
    }

    // Update connection attempts
    if (connectionAttemptsEl) {
      connectionAttemptsEl.textContent = connectionAttempts.toString();
    }

    // Update messages received
    if (messagesReceivedEl) {
      messagesReceivedEl.textContent = messagesReceived.toString();
    }

    // Update current task
    if (currentTaskEl) {
      const taskInput = document.getElementById('task');
      currentTaskEl.textContent = isResearchActive && taskInput && taskInput.value ?
        (taskInput.value.length > 30 ? taskInput.value.substring(0, 27) + '...' : taskInput.value) :
        '-';
    }
  }

  // Get socket status object
  const getSocketStatus = () => {
    if (!socket) {
      return {
        statusText: '未连接',
        indicatorClass: 'disconnected'
      };
    }

    switch (socket.readyState) {
      case WebSocket.CONNECTING:
        return {
          statusText: '连接中',
          indicatorClass: 'connecting'
        };
      case WebSocket.OPEN:
        return {
          statusText: '已连接',
          indicatorClass: 'connected'
        };
      case WebSocket.CLOSING:
        return {
          statusText: '正在关闭',
          indicatorClass: 'connecting'
        };
      case WebSocket.CLOSED:
      default:
        return {
          statusText: '未连接',
          indicatorClass: 'disconnected'
        };
    }
  }

  // Get readable text for WebSocket readyState
  const getReadyStateText = (readyState) => {
    switch (readyState) {
      case WebSocket.CONNECTING:
        return '0（连接中）';
      case WebSocket.OPEN:
        return '1（已打开）';
      case WebSocket.CLOSING:
        return '2（正在关闭）';
      case WebSocket.CLOSED:
        return '3（已关闭）';
      default:
        return `${readyState} (Unknown)`;
    }
  }

  // Format duration in seconds to human-readable string
  const formatDuration = (seconds) => {
    if (seconds < 60) {
      return `${seconds} sec`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)} min ${seconds % 60} sec`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours} hr ${minutes} min`;
    }
  }

  // Load conversation history from cookie
  const loadConversationHistory = () => {
    try {
      const storedHistory = getCookie('conversationHistory');
      if (storedHistory && storedHistory.trim() !== '') {
        try {
          const parsedHistory = JSON.parse(storedHistory);
          if (Array.isArray(parsedHistory)) {
            conversationHistory = parsedHistory;
            console.debug('Loaded research history from storage:', conversationHistory);
            console.log('Loaded research history:', conversationHistory.length, 'items');
          } else {
            console.warn('History storage does not contain an array');
            conversationHistory = [];
            deleteCookie('conversationHistory');
          }
        } catch (jsonError) {
          console.error('Invalid JSON in history storage:', jsonError);
          conversationHistory = [];
          deleteCookie('conversationHistory');
        }
      } else {
        console.log('No research history found in storage');
        conversationHistory = [];
      }
    } catch (error) {
      console.error('Error loading research history from storage:', error);
      conversationHistory = [];
      // If JSON parsing fails, delete the corrupt cookie
      deleteCookie('conversationHistory');
    }

    // Force render after loading
    renderHistoryEntries();
  }

  // Save conversation history to browser storage
  const saveConversationHistory = (silent = false) => {
    try {
      if (conversationHistory.length === 0) {
        deleteCookie('conversationHistory');
        console.debug('No history to save, deleted storage');
        return;
      }

      // Only keep the last 20 entries
      let storageHistory = [...conversationHistory];
      if (storageHistory.length > 20) {
        storageHistory = storageHistory.slice(0, 20);
        console.debug('Trimmed history to last 20 entries');
      }

      // Keep the fields needed to restore and display daily intel history.
      storageHistory = storageHistory.map((entry, index) => ({
        id: entry.id || `legacy-${entry.timestamp || Date.now()}-${index}`,
        title: entry.title || '',
        prompt: entry.prompt || '',
        content: entry.content || '',
        links: entry.links || {},
        reportType: entry.reportType || '',
        reportSource: entry.reportSource || '',
        tone: entry.tone || '',
        queryDomains: entry.queryDomains || [],
        timestamp: entry.timestamp || new Date().toISOString(),
        status: entry.status || '',
      }));

      const jsonString = JSON.stringify(storageHistory);
      console.debug('History JSON size:', jsonString.length, 'characters');

      const saved = setCookie('conversationHistory', jsonString, 30);

      if (saved && storageHistory.length > 0 && !isInitialLoad && !silent) {
        showToast('情报历史已保存！');
      }
    } catch (error) {
      console.error('Error saving research history:', error);
      showToast('保存历史记录失败，部分记录可能未保存。');
    }
  }

  // Delete a history entry
  const deleteHistoryEntry = (index) => {
    if (confirm('确定要删除这条情报历史吗？')) {
      conversationHistory.splice(index, 1);
      saveConversationHistory();
      renderHistoryEntries();
      showToast('记录已删除');
    }
  }

  // Clear all conversation history
  const clearConversationHistory = () => {
    if (confirm('确定要清空全部情报历史吗？此操作无法撤销。')) {
      conversationHistory = [];
      saveConversationHistory();
      renderHistoryEntries();
      showToast('情报历史已清空');
    }
  }

  // Filter history entries based on search term
  const filterHistoryEntries = () => {
    const searchTerm = document.getElementById('historySearch').value.toLowerCase();
    const historyEntries = document.getElementById('historyEntries');

    if (!historyEntries) return;

    const entries = historyEntries.querySelectorAll('.history-entry');

    entries.forEach(entry => {
      const title = entry.querySelector('.history-entry-title').textContent.toLowerCase();
      // Search only in the title since we no longer have preview text
      if (title.includes(searchTerm)) {
        entry.style.display = 'block';
      } else {
        entry.style.display = 'none';
      }
    });
  }

  // Sort history entries by timestamp
  const sortHistoryEntries = (order) => {
    conversationHistory.sort((a, b) => {
      // Default to newest first if timestamps don't exist
      if (!a.timestamp || !b.timestamp) return 0;

      if (order === 'newest') {
        return new Date(b.timestamp) - new Date(a.timestamp);
      } else {
        return new Date(a.timestamp) - new Date(b.timestamp);
      }
    });
  }

  // Render history entries in the panel
  const renderHistoryEntries = () => {
    const historyEntries = document.getElementById('historyEntries');
    if (!historyEntries) return;

    historyEntries.innerHTML = '';

    if (!conversationHistory || conversationHistory.length === 0) {
      historyEntries.innerHTML = '<p class="text-center mt-4 text-muted">暂无情报历史。</p>';
      return;
    }

    // Sort by the current selection
    const sortOrder = document.getElementById('historySortOrder')?.value || 'newest';
    sortHistoryEntries(sortOrder);
    console.debug('Sorted history entries:', sortOrder);

    conversationHistory.forEach((entry, index) => {
      const entryElement = document.createElement('div');
      entryElement.className = 'history-entry';
      entryElement.setAttribute('data-id', index);

      // Make the entire entry clickable to load it
      entryElement.addEventListener('click', () => {
        loadResearchEntry(index);
      });

      // Format timestamp if available
      let timestampHTML = '';
      if (entry.timestamp) {
        try {
          const timestamp = new Date(entry.timestamp);
          const formattedDate = timestamp.toLocaleDateString();
          const formattedTime = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          timestampHTML = `<span class="history-entry-timestamp">${formattedDate} ${formattedTime}</span>`;
        } catch (e) {
          console.error('Error formatting timestamp:', e);
        }
      }

      // Make sure links object exists
      const links = entry.links || {};

      // Build the HTML for the entry with enhanced formatting
      entryElement.innerHTML = `
        <div class="history-entry-header">
          <h4 class="history-entry-title">${entry.title || entry.prompt || '未命名情报报告'}</h4>
          ${timestampHTML}
        </div>
        ${entry.status ? `<div class="history-entry-status">${entry.status}</div>` : ''}
        <div class="history-entry-format">
          ${links.pdf ? `<a href="${links.pdf}" class="history-entry-action" target="_blank" title="打开 PDF 报告"><i class="fas fa-file-pdf"></i> PDF</a>` : ''}
          ${links.docx ? `<a href="${links.docx}" class="history-entry-action" target="_blank" title="打开 Word 文档"><i class="fas fa-file-word"></i> Word</a>` : ''}
          ${links.md ? `<a href="${links.md}" class="history-entry-action" target="_blank" title="打开 Markdown 文件"><i class="fas fa-file-lines"></i> MD</a>` : ''}
          ${links.json ? `<a href="${links.json}" class="history-entry-action" target="_blank" title="打开 JSON 数据"><i class="fas fa-file-code"></i> JSON</a>` : ''}
        </div>
        <div class="history-entry-actions">
          <button class="history-entry-action delete-entry" title="删除这条情报历史"><i class="fas fa-trash-alt"></i></button>
        </div>
      `;

      // Add action button handlers
      const deleteBtn = entryElement.querySelector('.delete-entry');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteHistoryEntry(index);
        });
      }

      historyEntries.appendChild(entryElement);
      setTimeout(() => {
        entryElement.style.animationDelay = `${index * 50}ms`;
      }, 0);
    });
  }

  // Load a research entry from history
  const loadResearchEntry = (index) => {
    const entry = conversationHistory[index];
    if (!entry) return;

    // Fill form with the entry data
    document.getElementById('task').value = entry.prompt; // Changed from entry.task for consistency
    
    // Check if report_type, report_source, and tone are in entry, otherwise use defaults or skip
    const reportTypeSelect = document.querySelector('select[name="report_type"]');
    if (reportTypeSelect && entry.reportType) {
        reportTypeSelect.value = entry.reportType;
    } else if (reportTypeSelect) {
        reportTypeSelect.value = reportTypeSelect.options[0].value; // Default to first option
    }

    const reportSourceSelect = document.querySelector('select[name="report_source"]');
    if (reportSourceSelect && entry.reportSource) {
        reportSourceSelect.value = entry.reportSource;
    } else if (reportSourceSelect) {
        reportSourceSelect.value = reportSourceSelect.options[0].value; // Default to first option
    }

    const toneSelect = document.querySelector('select[name="tone"]');
    if (toneSelect && entry.tone) {
        toneSelect.value = entry.tone;
    } else if (toneSelect) {
        toneSelect.value = toneSelect.options[0].value; // Default to first option
    }

    const queryDomainsInput = document.querySelector('input[name="query_domains"]');
    if (queryDomainsInput) {
        if (entry.queryDomains && Array.isArray(entry.queryDomains) && entry.queryDomains.length > 0) {
            queryDomainsInput.value = entry.queryDomains.join(', ');
        } else {
            queryDomainsInput.value = ''; // Clear if not present
        }
    }

    // Clear current research/report areas
    document.getElementById('output').innerHTML = '';
    document.getElementById('reportContainer').innerHTML = '';
    document.getElementById('selectedImagesContainer').innerHTML = '';
    document.getElementById('selectedImagesContainer').style.display = 'none';

    // Hide download bar and chat
    const stickyDownloadsBar = document.getElementById('stickyDownloadsBar');
    if (stickyDownloadsBar) {
        stickyDownloadsBar.classList.remove('visible');
    }
    const chatContainer = document.getElementById('chatContainer');
    if (chatContainer) {
        chatContainer.style.display = 'none';
    }

    // Reset UI state and report-specific buttons
    updateState('initial'); // This will hide copy buttons etc.

    // Close the history panel
    const historyPanel = document.getElementById('historyPanel');
    if (historyPanel) {
        historyPanel.classList.remove('open');
    }

    // Scroll to the form
    const formElement = document.getElementById('form');
    if (formElement) {
        formElement.scrollIntoView({ behavior: 'smooth' });
    }

    // Inform user
    showToast('情报参数已载入，可以重新开始搜集。');
  }

  // Copy entry content to clipboard
  const copyEntryToClipboard = (index) => {
    const entry = conversationHistory[index];
    if (!entry || !entry.content) return;

    const textarea = document.createElement('textarea');
    textarea.value = entry.content;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);

    // Show a toast notification
    showToast('情报内容已复制到剪贴板！');
  }

  // Show a toast notification
  const showToast = (message, duration = 3000) => {
    // Create toast element if it doesn't exist
    let toast = document.getElementById('toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast-notification';
      toast.className = 'toast-notification';
      document.body.appendChild(toast);
    }

    // Set message and show
    toast.textContent = message;
    toast.classList.add('show');

    // Hide after specified duration
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // Save current daily intel report to history.
  const saveToHistory = (report, downloadLinks) => {
    if (!downloadLinks) {
      console.error('No download links provided');
      showToast('错误：无法保存到情报历史');
      return;
    }
    upsertCurrentHistory(report, downloadLinks);
    document.getElementById('historyPanel')?.classList.add('open');
    showToast('每日情报速递已保存到历史。');
  }

  const buildHistoryTitle = () => {
    const name = document.getElementById('intelName')?.value?.trim() || '每日情报速递';
    const targets = document.getElementById('intelTargets')?.value?.trim() || '公开动态';
    return `${name} · ${targets}`;
  }

  const upsertCurrentHistory = (report = '', downloadLinks = null) => {
    const prompt = document.getElementById('task')?.value || buildDailyIntelTask();
    const title = buildHistoryTitle();
    const links = {
      pdf: downloadLinks?.pdf || '',
      docx: downloadLinks?.docx || '',
      md: downloadLinks?.md || '',
      json: downloadLinks?.json || '',
    };

    if (!conversationHistory) {
      conversationHistory = [];
    }

    let entry = currentHistoryId
      ? conversationHistory.find((item) => item.id === currentHistoryId)
      : null;

    if (!entry) {
      currentHistoryId = `intel-${Date.now()}`;
      entry = {
        id: currentHistoryId,
        title,
        prompt,
        content: report,
        links,
        reportType: document.querySelector('select[name="report_type"]')?.value || '',
        reportSource: document.querySelector('select[name="report_source"]')?.value || '',
        tone: document.querySelector('select[name="tone"]')?.value || '',
        queryDomains: collectCsv(document.querySelector('input[name="query_domains"]')?.value),
        timestamp: new Date().toISOString(),
        status: '生成中',
      };
      conversationHistory.unshift(entry);
    } else {
      entry.title = title;
      entry.prompt = prompt;
      entry.content = report || entry.content || '';
      entry.links = { ...(entry.links || {}), ...links };
      entry.timestamp = new Date().toISOString();
    }

    if (downloadLinks) {
      entry.status = '已完成';
    }

    saveConversationHistory(!downloadLinks);
    renderHistoryEntries();
  }

  // Function to update the research icon spinning state
  const updateResearchIcon = (isSpinning) => {
    const modernSpinner = document.getElementById('modernSpinner');
    if (modernSpinner) {
      if (isSpinning) {
        modernSpinner.classList.add('spinning');
      } else {
        modernSpinner.classList.remove('spinning');
      }
    }
  };

  const setResearchPanelsVisibility = ({ showProgress = false, showReport = false } = {}) => {
    const researchOutputContainer = document.querySelector('.research-output-container');
    const reportContainer = document.querySelector('.report-container');

    if (researchOutputContainer) {
      researchOutputContainer.style.display = showProgress ? 'block' : 'none';
    }
    if (reportContainer) {
      reportContainer.style.display = showReport ? 'block' : 'none';
    }
  };

  const startResearch = () => {
    document.getElementById('output').innerHTML = ''
    document.getElementById('reportContainer').innerHTML = ''
    dispose_socket?.() // Call previous dispose function if it exists

    // Reset report variables
    allReports = '';
    currentReport = '';
    isFirstReport = true;
    currentHistoryId = null;

    // Hide the download bar
    const stickyDownloadsBar = document.getElementById('stickyDownloadsBar');
    if (stickyDownloadsBar) {
      stickyDownloadsBar.classList.remove('visible');
    }

    // Hide the chat container
    chatContainer = document.getElementById('chatContainer');
    if (chatContainer) {
      chatContainer.style.display = 'none';
    }

    const imageContainer = document.getElementById('selectedImagesContainer')
    imageContainer.innerHTML = ''
    imageContainer.style.display = 'none'

    setResearchPanelsVisibility({ showProgress: true, showReport: false });
    updateState('in_progress')

    const intelTask = buildDailyIntelTask();
    document.getElementById('task').value = intelTask;

    addAgentResponse({
      output: '正在搜集公开公司、产品和行业动态...',
    })

    // Scroll to the "Research Progress" section
    const researchOutputContainer = document.querySelector('.research-output-container');
    if (researchOutputContainer) {
        researchOutputContainer.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
        });
    }

    dispose_socket = listenToSockEvents() // Assign the new dispose function
  }

  const collectCsv = (value) => (value || '')
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const getSelectedIntelCategories = () => Array.from(document.querySelectorAll('#intelCategories input[type="checkbox"]:checked'))
    .map((checkbox) => checkbox.value);

  const modelProviderMeta = {
    openai: {
      icon: '◎',
      hint: '在 OpenAI Platform 获取 API 密钥',
      helpUrl: 'https://platform.openai.com/api-keys',
    },
    deepseek: {
      icon: 'DS',
      hint: '在 DeepSeek 控制台获取 API 密钥',
      helpUrl: 'https://platform.deepseek.com/api_keys',
    },
    doubao: {
      icon: '豆',
      hint: '在火山引擎方舟获取 API 密钥',
      helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    },
    gemini: {
      icon: 'G',
      hint: '在 Google AI Studio 获取 API 密钥',
      helpUrl: 'https://aistudio.google.com/app/apikey',
    },
    custom: {
      icon: 'API',
      hint: '填写任意 OpenAI 兼容接口',
      helpUrl: '#',
    },
  };

  const loadModelConfig = async () => {
    try {
      const response = await fetch('/api/model-config');
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      modelProviders = data.providers || [];
      selectedModelProvider = data.active_provider || 'openai';
      renderModelProviders();
      fillModelConfigForm(data.active || {});
      updateModelStatus(data.active || {});
    } catch (error) {
      console.error('Failed to load model config:', error);
      const status = document.getElementById('modelConfigStatus');
      if (status) status.textContent = '读取失败';
    }
  };

  const renderModelProviders = () => {
    const container = document.getElementById('modelProviderList');
    if (!container) return;
    container.innerHTML = modelProviders.map((provider) => {
      const meta = modelProviderMeta[provider.id] || modelProviderMeta.custom;
      const active = provider.id === selectedModelProvider;
      return `
        <button type="button" class="model-provider-item ${active ? 'is-active' : ''}" data-provider="${provider.id}">
          <span class="model-provider-mini">${meta.icon}</span>
          <span>
            <strong>${escapeHtml(provider.name)}</strong>
            <small>${provider.configured ? '已配置' : '未配置'}</small>
          </span>
          <i class="fas ${active ? 'fa-circle-check' : 'fa-circle'}"></i>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.model-provider-item').forEach((button) => {
      button.addEventListener('click', () => selectModelProvider(button.dataset.provider));
    });
  };

  const selectModelProvider = (providerId) => {
    selectedModelProvider = providerId;
    const provider = modelProviders.find((item) => item.id === providerId) || {};
    renderModelProviders();
    fillModelConfigForm({
      provider: providerId,
      provider_name: provider.name,
      base_url: provider.base_url,
      model_id: provider.model_id,
      api_key_configured: provider.api_key_configured,
      embedding: document.getElementById('modelEmbedding')?.value || 'local:hash',
    });
  };

  const fillModelConfigForm = (config) => {
    const providerId = config.provider || selectedModelProvider;
    const provider = modelProviders.find((item) => item.id === providerId) || {};
    const meta = modelProviderMeta[providerId] || modelProviderMeta.custom;
    const nameEl = document.getElementById('modelProviderName');
    const hintEl = document.getElementById('modelProviderHint');
    const logoEl = document.getElementById('modelProviderLogo');
    const helpEl = document.getElementById('modelApiHelp');
    const apiKeyEl = document.getElementById('modelApiKey');

    if (nameEl) nameEl.textContent = config.provider_name || provider.name || '模型供应商';
    if (hintEl) hintEl.textContent = meta.hint;
    if (logoEl) logoEl.textContent = meta.icon;
    if (helpEl) {
      helpEl.href = meta.helpUrl;
      helpEl.style.display = meta.helpUrl === '#' ? 'none' : 'inline-flex';
    }
    if (apiKeyEl) {
      apiKeyEl.value = '';
      apiKeyEl.placeholder = config.api_key_configured ? '已配置，留空则不覆盖' : '请输入 API Key';
    }
    const baseUrlEl = document.getElementById('modelBaseUrl');
    const modelIdEl = document.getElementById('modelId');
    const embeddingEl = document.getElementById('modelEmbedding');
    if (baseUrlEl) baseUrlEl.value = config.base_url || provider.base_url || '';
    if (modelIdEl) modelIdEl.value = config.model_id || provider.model_id || '';
    if (embeddingEl) embeddingEl.value = config.embedding || 'local:hash';
  };

  const updateModelStatus = (config) => {
    const status = document.getElementById('modelConfigStatus');
    if (!status) return;
    status.textContent = config.api_key_configured
      ? `${config.provider_name || '模型'} 已配置`
      : `${config.provider_name || '模型'} 未配置`;
  };

  const saveModelConfig = async () => {
    const payload = {
      provider: selectedModelProvider,
      api_key: document.getElementById('modelApiKey')?.value?.trim() || '',
      base_url: document.getElementById('modelBaseUrl')?.value?.trim() || '',
      model_id: document.getElementById('modelId')?.value?.trim() || '',
      embedding: document.getElementById('modelEmbedding')?.value || 'local:hash',
    };
    if (!payload.model_id) {
      showToast('请填写模型 ID');
      return;
    }
    try {
      const response = await fetch('/api/model-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      modelProviders = data.providers || [];
      selectedModelProvider = data.active_provider || payload.provider;
      renderModelProviders();
      fillModelConfigForm(data.active || {});
      updateModelStatus(data.active || {});
      showToast('模型配置已保存，后续任务会使用新的模型');
    } catch (error) {
      console.error('Failed to save model config:', error);
      showToast('保存模型配置失败，请查看后端日志');
    }
  };

  const collectIntelJobPayload = () => ({
    id: window.currentIntelJobId || null,
    name: document.getElementById('intelName')?.value?.trim() || '每日情报速递',
    targets: collectCsv(document.getElementById('intelTargets')?.value),
    keywords: collectCsv(document.getElementById('intelKeywords')?.value),
    source_categories: getSelectedIntelCategories(),
    domains: collectCsv(document.getElementById('queryDomains')?.value),
    schedule_time: document.getElementById('intelScheduleTime')?.value || '09:00',
    time_window_days: Number(document.getElementById('intelTimeWindowDays')?.value || 7),
    enabled: Boolean(document.getElementById('intelEnabled')?.checked),
    email_recipients: collectCsv(document.getElementById('intelEmailRecipients')?.value),
    smtp_host: document.getElementById('smtpHost')?.value?.trim() || '',
    smtp_port: Number(document.getElementById('smtpPort')?.value || 587),
    smtp_username: document.getElementById('smtpUsername')?.value?.trim() || '',
    smtp_password: document.getElementById('smtpPassword')?.value || '',
    smtp_from: document.getElementById('smtpFrom')?.value?.trim() || '',
    smtp_use_tls: Boolean(document.getElementById('smtpUseTls')?.checked),
  });

  const formatIntelDateTime = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const categoryLabels = {
    news: '新闻',
    funding: '融资',
    product: '产品发布',
    tech_blog: '技术博客',
    industry: '行业动态',
  };

  const statusLabels = {
    queued: '排队中',
    running: '运行中',
    success: '成功',
    failed: '失败',
    skipped: '跳过',
  };

  const fillIntelForm = (job) => {
    if (!job) return;
    window.currentIntelJobId = job.id;
    document.getElementById('intelName').value = job.name || '';
    document.getElementById('intelTargets').value = (job.targets || []).join(', ');
    document.getElementById('intelKeywords').value = (job.keywords || []).join(', ');
    document.getElementById('queryDomains').value = (job.domains || []).join(', ');
    document.getElementById('intelScheduleTime').value = job.schedule_time || '09:00';
    document.getElementById('intelTimeWindowDays').value = String(job.time_window_days || 7);
    document.getElementById('intelEmailRecipients').value = (job.email_recipients || []).join(', ');
    document.getElementById('smtpHost').value = job.smtp_host || '';
    document.getElementById('smtpPort').value = job.smtp_port || 587;
    document.getElementById('smtpUsername').value = job.smtp_username || '';
    document.getElementById('smtpFrom').value = job.smtp_from || '';
    document.getElementById('smtpPassword').value = '';
    document.getElementById('smtpPassword').placeholder = job.smtp_password_configured ? '已配置，留空则不覆盖' : '请输入 SMTP 授权码/密码';
    document.getElementById('smtpUseTls').checked = job.smtp_use_tls !== false;
    document.getElementById('intelEnabled').checked = Boolean(job.enabled);
    document.querySelectorAll('#intelCategories input[type="checkbox"]').forEach((checkbox) => {
      checkbox.checked = (job.source_categories || []).includes(checkbox.value);
    });
    showToast(`已载入订阅：${job.name}`);
    document.getElementById('intelName')?.focus();
    renderIntelJobs();
  };

  const resetIntelForm = () => {
    window.currentIntelJobId = null;
    document.getElementById('intelName').value = '';
    document.getElementById('intelTargets').value = '';
    document.getElementById('intelKeywords').value = '';
    document.getElementById('queryDomains').value = '';
    document.getElementById('intelScheduleTime').value = '09:00';
    document.getElementById('intelTimeWindowDays').value = '7';
    document.getElementById('intelEmailRecipients').value = '';
    document.getElementById('smtpHost').value = '';
    document.getElementById('smtpPort').value = 587;
    document.getElementById('smtpUsername').value = '';
    document.getElementById('smtpFrom').value = '';
    document.getElementById('smtpPassword').value = '';
    document.getElementById('smtpPassword').placeholder = '请输入 SMTP 授权码/密码';
    document.getElementById('smtpUseTls').checked = true;
    document.getElementById('intelEnabled').checked = true;
    document.querySelectorAll('#intelCategories input[type="checkbox"]').forEach((checkbox) => {
      checkbox.checked = true;
    });
    renderIntelJobs();
    showToast('已切换到新建订阅');
    document.getElementById('intelName')?.focus();
  };

  const renderIntelJobs = () => {
    const container = document.getElementById('intelJobsList');
    if (!container) return;
    if (!dailyIntelJobs.length) {
      container.innerHTML = '<div class="intel-empty">暂无订阅，保存上方配置后会显示在这里。</div>';
      return;
    }

    container.innerHTML = dailyIntelJobs.map((job) => {
      const categories = (job.source_categories || []).map((item) => categoryLabels[item] || item).join('、') || '全部分类';
      const targets = (job.targets || []).join('、') || '未限定目标';
      const enabledClass = job.enabled ? 'is-enabled' : 'is-disabled';
      const enabledText = job.enabled ? '已启用' : '已停用';
      return `
        <article class="intel-card ${window.currentIntelJobId === job.id ? 'is-selected' : ''}" data-job-id="${job.id}">
          <div class="intel-card-top">
            <div>
              <h4>${escapeHtml(job.name || '未命名订阅')}</h4>
              <p>${escapeHtml(targets)}</p>
            </div>
            <span class="intel-badge ${enabledClass}">${enabledText}</span>
          </div>
          <div class="intel-card-meta">
            <span><i class="fas fa-layer-group"></i>${escapeHtml(categories)}</span>
            <span><i class="fas fa-clock"></i>每日 ${escapeHtml(job.schedule_time || '09:00')}</span>
            <span><i class="fas fa-calendar-check"></i>下次 ${formatIntelDateTime(job.next_run_at)}</span>
          </div>
          <div class="intel-card-actions">
            <button type="button" data-action="edit">编辑</button>
            <button type="button" data-action="toggle">${job.enabled ? '停用' : '启用'}</button>
            <button type="button" data-action="run">运行</button>
            <button type="button" data-action="delete" class="danger">删除</button>
          </div>
        </article>
      `;
    }).join('');
  };

  const renderIntelRuns = () => {
    const container = document.getElementById('intelRunsList');
    if (!container) return;
    if (!dailyIntelRuns.length) {
      container.innerHTML = '<div class="intel-empty">暂无运行记录。</div>';
      return;
    }

    container.innerHTML = dailyIntelRuns.slice(0, 12).map((run) => {
      const statusText = statusLabels[run.status] || run.status || '未知';
      const pushText = statusLabels[run.push_status] || run.push_status || '未知';
      const stageMessage = run.stage_message || run.error || run.quality_summary || run.summary || '';
      const reportLink = run.report_url
        ? `<a href="/daily-intel/report/${escapeHtml(run.id)}" target="_blank" rel="noopener noreferrer">详情</a><a href="${escapeHtml(run.report_url)}" target="_blank" rel="noopener noreferrer">Markdown</a>`
        : '<span>无报告</span>';
      return `
        <article class="intel-run-row">
          <div>
            <strong>${escapeHtml(run.job_name || '未命名订阅')}</strong>
            <p>${formatIntelDateTime(run.started_at)} - ${formatIntelDateTime(run.finished_at)}</p>
            <p>${escapeHtml(stageMessage).slice(0, 160)}</p>
            ${run.error ? `<p class="intel-run-error">${escapeHtml(run.error).slice(0, 220)}</p>` : ''}
          </div>
          <span class="intel-badge ${run.status === 'success' || run.status === 'running' || run.status === 'queued' ? 'is-enabled' : 'is-disabled'}">${statusText}</span>
          <span class="intel-run-push">质量：${typeof run.quality_score === 'number' ? run.quality_score : '-'}</span>
          <span class="intel-run-push">过滤旧动态：${typeof run.filtered_old_item_count === 'number' ? run.filtered_old_item_count : '-'}</span>
          <span class="intel-run-push">邮件：${pushText}</span>
          ${reportLink}
        </article>
      `;
    }).join('');
  };

  const loadIntelJobs = async () => {
    try {
      const response = await fetch('/api/daily-intel/jobs');
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      dailyIntelJobs = data.jobs || [];
      renderIntelJobs();
    } catch (error) {
      console.error('Failed to load daily intel jobs:', error);
      showToast('加载订阅列表失败');
    }
  };

  const loadIntelRuns = async () => {
    try {
      const response = await fetch('/api/daily-intel/runs');
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      dailyIntelRuns = data.runs || [];
      renderIntelRuns();
    } catch (error) {
      console.error('Failed to load daily intel runs:', error);
      showToast('加载运行记录失败');
    }
  };

  const updateIntelJob = async (job) => {
    const response = await fetch(`/api/daily-intel/jobs/${job.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };

  const deleteIntelJob = async (job) => {
    if (!confirm(`确定删除订阅“${job.name}”吗？`)) return;
    try {
      const response = await fetch(`/api/daily-intel/jobs/${job.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await response.text());
      if (window.currentIntelJobId === job.id) {
        window.currentIntelJobId = null;
      }
      await loadIntelJobs();
      showToast('订阅已删除');
    } catch (error) {
      console.error('Failed to delete daily intel job:', error);
      showToast('删除订阅失败');
    }
  };

  const toggleIntelJob = async (job) => {
    try {
      await updateIntelJob({ ...job, enabled: !job.enabled });
      await loadIntelJobs();
      showToast(job.enabled ? '已停用自动抓取' : '已启用自动抓取');
    } catch (error) {
      console.error('Failed to toggle daily intel job:', error);
      showToast('切换启用状态失败');
    }
  };

  const setIntelRunStatus = (step, detail = '') => {
    const panel = document.getElementById('intelRunStatus');
    const text = document.getElementById('intelRunStatusText');
    if (!panel || !text) return;
    panel.hidden = false;
    panel.dataset.step = step;
    text.textContent = detail;
    panel.querySelectorAll('[data-run-step]').forEach((item) => {
      const order = Number(item.dataset.runStep);
      item.classList.toggle('is-active', order === step);
      item.classList.toggle('is-done', order < step);
    });
  };

  const setIntelRunBusy = (busy) => {
    const saveButton = document.getElementById('saveIntelJobBtn');
    const runButton = document.getElementById('runIntelJobBtn');
    if (saveButton) saveButton.disabled = busy;
    if (runButton) {
      runButton.disabled = busy;
      runButton.textContent = busy ? '正在运行...' : '立即运行一次';
    }
  };

  const clearIntelRunStatus = () => {
    const panel = document.getElementById('intelRunStatus');
    if (panel) {
      panel.dataset.step = '0';
    }
  };

  const stopIntelRunPolling = () => {
    if (activeIntelRunPoller) {
      clearInterval(activeIntelRunPoller);
      activeIntelRunPoller = null;
    }
  };

  const mapRunStageToStep = (stage) => {
    if (['queued', 'starting', 'prompt'].includes(stage)) return 1;
    if (['researching', 'filtering', 'exporting'].includes(stage)) return 2;
    if (stage === 'pushing') return 3;
    return 4;
  };

  const updateRunStatusFromRun = (run) => {
    const stage = run?.stage || run?.status || 'running';
    const message = run?.stage_message || run?.error || '正在运行...';
    const step = mapRunStageToStep(stage);
    setIntelRunStatus(step, message);
  };

  const pollIntelRunDetail = (runId) => {
    stopIntelRunPolling();
    activeIntelRunPoller = setInterval(async () => {
      try {
        const response = await fetch(`/api/daily-intel/runs/${runId}`);
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        const run = data.run;
        updateRunStatusFromRun(run);
        await loadIntelRuns();
        if (['success', 'failed'].includes(run.status)) {
          stopIntelRunPolling();
          await loadIntelJobs();
          setIntelRunBusy(false);
          showToast(run.status === 'success' ? '运行完成，报告已生成' : '运行失败，请查看错误信息', 5000);
        }
      } catch (error) {
        console.error('Failed to poll daily intel run:', error);
        stopIntelRunPolling();
        setIntelRunBusy(false);
        setIntelRunStatus(4, '无法获取运行详情，请刷新运行记录或查看后端日志');
      }
    }, 2000);
  };

  const runIntelJobById = async (jobId) => {
    setIntelRunBusy(true);
    setIntelRunStatus(1, '正在提交后台运行任务...');
    showToast('已提交立即运行，页面会自动刷新运行详情');
    try {
      const response = await fetch(`/api/daily-intel/jobs/${jobId}/run`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = await response.json();
      updateRunStatusFromRun(data.run);
      await loadIntelJobs();
      await loadIntelRuns();
      if (data.run?.id && !['success', 'failed'].includes(data.run?.status)) {
        pollIntelRunDetail(data.run.id);
      } else {
        setIntelRunBusy(false);
      }
      return data.run;
    } catch (error) {
      console.error('Failed to run daily intel job:', error);
      setIntelRunStatus(4, '运行失败，请查看运行记录或后端日志');
      showToast('立即运行失败，可能缺少 API key、模型配置或外部网络不可用', 5000);
      setIntelRunBusy(false);
      return null;
    }
  };

  document.addEventListener('click', (event) => {
    const actionButton = event.target.closest?.('#intelJobsList button[data-action]');
    if (!actionButton) return;
    const card = actionButton.closest('.intel-card');
    const job = dailyIntelJobs.find((item) => item.id === card?.dataset.jobId);
    if (!job) return;

    const action = actionButton.dataset.action;
    if (action === 'edit') fillIntelForm(job);
    if (action === 'toggle') toggleIntelJob(job);
    if (action === 'run') runIntelJobById(job.id);
    if (action === 'delete') deleteIntelJob(job);
  });

  const saveIntelJob = async () => {
    const payload = collectIntelJobPayload();
    if (!payload.name) {
      showToast('请先填写名称');
      return null;
    }
    try {
      const isUpdate = Boolean(window.currentIntelJobId);
      setIntelRunStatus(1, isUpdate ? '正在保存修改后的订阅...' : '正在保存新订阅...');
      const response = await fetch(isUpdate ? `/api/daily-intel/jobs/${window.currentIntelJobId}` : '/api/daily-intel/jobs', {
        method: isUpdate ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = await response.json();
      window.currentIntelJobId = data.job?.id;
      await loadIntelJobs();
      showToast(isUpdate ? '情报订阅已更新' : '情报订阅已保存');
      return data.job;
    } catch (error) {
      console.error('Failed to save daily intel job:', error);
      showToast('保存订阅失败，请查看后端日志');
      return null;
    }
  };

  const runIntelJobNow = async () => {
    const job = await saveIntelJob();
    if (!job?.id) return;
    await runIntelJobById(job.id);
  };

  const buildDailyIntelTask = () => {
    const payload = collectIntelJobPayload();
    const selectedCategoryKeys = payload.source_categories.length ? payload.source_categories : Object.keys(categoryLabels);
    const categories = selectedCategoryKeys
      .map((item) => categoryLabels[item] || item)
      .join('、');
    const excludedCategories = Object.keys(categoryLabels)
      .filter((item) => !selectedCategoryKeys.includes(item))
      .map((item) => categoryLabels[item])
      .join('、') || '无';
    const categorySections = selectedCategoryKeys
      .map((item) => `### ${categoryLabels[item] || item}`)
      .join('\n');
    const targets = payload.targets.join('、') || '目标公司/产品';
    const keywords = payload.keywords.join('、') || '发布、API、模型、Agent、企业服务、行业动态';
    const domains = payload.domains.join('、') || '不限域名，优先选择高可信公开来源';
    const today = new Date();
    const startDate = new Date(today.getTime() - payload.time_window_days * 24 * 60 * 60 * 1000);
    const formatDate = (date) => date.toISOString().slice(0, 10);

    return [
      `请作为“每日情报速递”分析助手，搜集公开可访问的公司、产品和行业信息，并生成中文情报报告。`,
      `名称：${payload.name}。`,
      `目标公司/产品：${targets}。`,
      `关键词：${keywords}。`,
      `来源分类：${categories}。`,
      `不需要输出的分类：${excludedCategories}。`,
      `限定域名：${domains}。`,
      `当前日期：${formatDate(today)}。时间范围：优先使用 ${formatDate(startDate)} 至 ${formatDate(today)} 之间发布或更新的信息。`,
      `只使用公开可访问来源，不抓取登录、验证码、付费墙之后的内容，不绕过反爬限制。`,
      `不要虚构来源；不确定的信息必须标注“不确定”；每条重要信息尽量带来源链接。`,
      `如果近期没有可靠公开信息，不要用旧材料凑数；请写“未发现近期可靠公开动态”。`,
      `整份报告必须使用中文输出；英文来源标题、公司名、产品名可以保留原文。`,
      `“分类情报”下面只能输出已选择的分类小标题，不要输出未选择的分类。`,
      ``,
      `请严格使用以下中文报告结构：`,
      `# 每日情报速递`,
      `## 今日摘要`,
      `## 分类情报`,
      categorySections,
      `## 重点公司/产品动态`,
      `## 商业信号`,
      `## 技术方向与产品趋势`,
      `## 风险、不确定性和待跟踪事项`,
      `## 来源链接`
    ].join('\n');
  }

  const listenToSockEvents = () => {
    const { protocol, host } = window.location
    const ws_uri = `${protocol === 'https:' ? 'wss:' : 'ws:'
      }//${host}/ws`

    // Set a timeout for connection - if it takes too long, stop the spinner
    connectionTimeout = setTimeout(() => {
      updateResearchIcon(false);
      console.log("WebSocket connection timed out");
    }, 10000); // 10 seconds timeout

    // Configure Showdown converter to properly handle code blocks
    const converter = new showdown.Converter({
      ghCodeBlocks: true,         // GitHub style code blocks
      tables: true,               // Enable tables
      tasklists: true,            // Enable task lists
      smartIndentationFix: true,  // Fix weird indentation
      simpleLineBreaks: true,     // Treat newlines as <br>
      openLinksInNewWindow: true, // Open links in new tab
      parseImgDimensions: true    // Parse image dimensions from markdown
    });

    // Fix issues with code block formatting
    converter.setOption('literalMidWordUnderscores', true);

    // Increment connection attempts counter
    connectionAttempts++;

    // Update WebSocket status
    updateWebSocketStatus();

    socket = new WebSocket(ws_uri)
    let reportContent = ''; // Store the report content for history
    let downloadLinkData = null; // Store download links

    socket.onmessage = (event) => {
      // Reset reconnect attempts on successful message
      reconnectAttempts = 0;

      const data = JSON.parse(event.data)
      console.log("Received message:", data);  // Debug log

      // Update WebSocket metrics
      messagesReceived++;
      lastActivityTime = Date.now();
      updateWebSocketStatus();

      if (data.type === 'logs') {
        if (data.content === 'error') {
          addAgentResponse(data);
          updateState('error');
          isResearchActive = false;
          return;
        }
        if (data.content === 'subqueries' && data.metadata && Array.isArray(data.metadata)) {
          displaySubQuestions(data.metadata)
        }
        addAgentResponse(data)
      } else if (data.type === 'error') {
        addAgentResponse(data);
        updateState('error');
        isResearchActive = false;
      } else if (data.type === 'images') {
        console.log("Received images:", data);  // Debug log
        displaySelectedImages(data)
      } else if (data.type === 'report') {
        setResearchPanelsVisibility({ showProgress: true, showReport: true });
        // Add to reportContent for history
        reportContent += data.output;
        upsertCurrentHistory(reportContent);

        // Get the current report_type
        const report_type = document.querySelector('select[name="report_type"]').value;

        // Determine if we're using detailed_report
        const isDetailedReport = report_type === 'detailed_report';

        if (isDetailedReport) {
          allReports += data.output; // Accumulate raw markdown
          // Always render the HTML of *all accumulated markdown* for detailed reports during streaming.
          // writeReport will replace the container's content.
          writeReport({ output: allReports, type: 'report' }, converter, false, false);
        } else {
          // For all other report types, append HTML of current chunk to the container.
          writeReport({ output: data.output, type: 'report' }, converter, false, true); // append = true
        }
      } else if (data.type === 'path') {
        updateState('finished')
        setResearchPanelsVisibility({ showProgress: true, showReport: true });
        downloadLinkData = updateDownloadLink(data)
        isResearchActive = false;

        // Get the current report_type
        const report_type = document.querySelector('select[name="report_type"]').value;

        // Only for detailed_report, show the complete accumulated report at the end
        if (report_type === 'detailed_report' && allReports) {
          const finalData = { output: allReports, type: 'report' };
          writeReport(finalData, converter, true, false); // isFinal=true, append=false
        }

        // Save or update history now that research is complete
        if (downloadLinkData) {
          upsertCurrentHistory(reportContent || allReports || currentReport, downloadLinkData);

          // Reset variables for next research session
          reportContent = '';
          allReports = '';
          currentReport = '';
          isFirstReport = true;
          currentHistoryId = null;
        }

        // Update WebSocket status
        updateWebSocketStatus();
      } else if (data.type === 'chat') {
        // Handle chat messages from the AI
        // Remove loading indicator and add AI's response
        const loadingElements = document.querySelectorAll('.chat-loading');
        if (loadingElements.length > 0) {
          loadingElements[loadingElements.length - 1].remove();
        }

        // Add AI message to chat
        if (data.content) {
          addChatMessage(data.content, false);
        }
      }
    }

    socket.onopen = (event) => {
      // Clear the connection timeout
      clearTimeout(connectionTimeout);

      // Update WebSocket metrics
      connectionStartTime = Date.now();
      lastActivityTime = Date.now();
      updateWebSocketStatus();

      // Reset reconnect attempts on successful connection
      reconnectAttempts = 0;

      // Ensure the research icon is spinning when connection is established
      updateResearchIcon(true);

      const task = document.getElementById('task').value
      const report_type = document.querySelector(
        'select[name="report_type"]'
      ).value
      const report_source = document.querySelector(
        'select[name="report_source"]'
      ).value
      const tone = document.querySelector('select[name="tone"]').value
      const agent = document.querySelector('input[name="agent"]:checked').value
      let source_urls = tags

      if (report_source !== 'sources' && source_urls.length > 0) {
        source_urls = source_urls.slice(0, source_urls.length - 1)
      }

      const query_domains_str = document.querySelector('input[name="query_domains"]').value
      let query_domains = []
      if (query_domains_str) {
        query_domains = query_domains_str.split(',')
          .map((domain) => domain.trim())
          .filter((domain) => domain.length > 0);
      }

      const requestData = {
        task: task,
        report_type: report_type,
        report_source: report_source,
        source_urls: source_urls,
        tone: tone,
        agent: agent,
        query_domains: query_domains,
        max_search_results: parseInt(document.getElementById('maxSearchResults').value, 10) || 5,
      }

      // Add MCP configuration if enabled
      const mcpData = collectMCPData();
      if (mcpData) {
        Object.assign(requestData, mcpData);
        console.log('Including MCP configuration:', mcpData);
      }

      // Store the request data for potential reconnection
      lastRequestData = requestData;

      socket.send(`start ${JSON.stringify(requestData)}`)
    }

    socket.onclose = (event) => {
      // Update metrics and status when connection closes
      connectionStartTime = null;
      updateWebSocketStatus();

      console.log("WebSocket connection closed", event);

      if (isResearchActive) {
        addAgentResponse({
          output: '连接已中断，当前采集任务已停止。请重新点击“开始生成当前情报报告”。',
        });
        updateState('error');
        isResearchActive = false;
        lastRequestData = null;
      }
    }

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      updateWebSocketStatus();
    }

    // return dispose function
    return () => {
      try {
        isResearchActive = false; // Mark research as inactive
        if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
          socket.close();
        }

        // Update metrics on socket disposal
        connectionStartTime = null;
        updateWebSocketStatus();
      } catch (e) {
        console.error('Error closing socket:', e)
      }
    };
  }

  const addAgentResponse = (data) => {
    const output = document.getElementById('output');
    const responseDiv = document.createElement('div');
    responseDiv.className = 'agent_response';
    responseDiv.innerHTML = data.output; // Assuming data.output is safe HTML or simple text from agent
    output.appendChild(responseDiv);
    output.scrollTop = output.scrollHeight;
    output.style.display = 'block';
  }

  const displaySubQuestions = (questions) => {
    const output = document.getElementById('output');
    const container = document.createElement('div');
    container.className = 'sub-questions';

    const heading = document.createElement('p');
    heading.className = 'sub-questions-heading';
    heading.textContent = '🤔 Pondering your question from several angles';
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'sub-questions-list';
    questions.forEach((q) => {
      const pill = document.createElement('span');
      pill.className = 'sub-question-pill';
      pill.textContent = q;
      list.appendChild(pill);
    });
    container.appendChild(list);

    output.appendChild(container);
    output.scrollTop = output.scrollHeight;
    output.style.display = 'block';
  }

  const writeReport = (data, converter, isFinal = false, append = false) => {
    const reportContainer = document.getElementById('reportContainer');

    // Convert markdown to HTML
    const markdownOutput = converter.makeHtml(data.output);

    // If this is the final report or we should append
    if (isFinal) {
      // For final reports, always replace content
      reportContainer.innerHTML = markdownOutput;
    } else if (append) {
      // Append mode - add to existing content
      reportContainer.innerHTML += markdownOutput;
    } else {
      // Replace mode - overwrite existing content
      reportContainer.innerHTML = markdownOutput;
    }

    // Auto-scroll to the bottom of the container
    reportContainer.scrollTop = reportContainer.scrollHeight;
  }

  const updateDownloadLink = (data) => {
    if (!data.output) {
      console.error('No output data received');
      return;
    }

    const { pdf, docx, md, json } = data.output;
    console.log('Received paths:', { pdf, docx, md, json });

    // Store these links for history
    const currentLinks = { pdf, docx, md, json };

    // Helper function to safely update link
    const updateLink = (id, path) => {
      const element = document.getElementById(id);
      if (element && path) {
        console.log(`Setting ${id} href to:`, path);
        element.setAttribute('href', path);
        element.classList.remove('disabled');
      } else {
        console.warn(`Either element ${id} not found or path not provided`);
      }
    };

    // Update links in sticky download bar
    updateLink('downloadLink', pdf);
    updateLink('downloadLinkWord', docx);
    updateLink('downloadLinkMd', md);
    updateLink('downloadLinkJson', json);

    // Update duplicate buttons above the report
    updateLink('downloadLinkTop', pdf);
    updateLink('downloadLinkWordTop', docx);
    updateLink('downloadLinkMdTop', md);
    updateLink('downloadLinkJsonTop', json);

    // Make sure download buttons are visible when download links are ready
    showDownloadPanels();

    // Return links for history saving
    return currentLinks;
  }

  const copyToClipboard = () => {
    const textarea = document.createElement('textarea')
    textarea.id = 'temp_element'
    textarea.style.height = 0
    document.body.appendChild(textarea)
    textarea.value = document.getElementById('reportContainer').innerText
    const selector = document.querySelector('#temp_element')
    selector.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)

    // Show a temporary success message with icon change and toast notification
    const copyBtn = document.getElementById('copyToClipboard');
    const copyBtnTop = document.getElementById('copyToClipboardTop');

    // Function to reset the icon for both buttons
    const resetIcons = () => {
      if (copyBtn) {
        copyBtn.innerHTML = '<i class="fas fa-copy"></i> 复制';
      }
      if (copyBtnTop) {
        copyBtnTop.innerHTML = '<i class="fas fa-copy"></i>';
      }
    };

    // Change to green check mark
    if (copyBtn) {
      copyBtn.innerHTML = '<i class="fas fa-check" style="color: green;"></i> 已复制！';
    }
    if (copyBtnTop) {
      copyBtnTop.innerHTML = '<i class="fas fa-check" style="color: green;"></i>';
    }

    // Show toast notification
    showToast('已复制到剪贴板！');

    // Reset the button after 3 seconds
    setTimeout(resetIcons, 3000);
  }

  const updateState = (state) => {
    var status = ''
    switch (state) {
      case 'in_progress':
        status = '研究进行中...'
        setReportActionsStatus('disabled')
        isResearchActive = true;
        // Make the research icon spin
        updateResearchIcon(true);
        // Hide chat container during research
        chatContainer = document.getElementById('chatContainer');
        if (chatContainer) {
          chatContainer.style.display = 'none';
        }
        // Hide the copy button in the header
        const copyBtnTop = document.getElementById('copyToClipboardTop');
        if (copyBtnTop) {
          copyBtnTop.style.display = 'none';
        }
        // Hide the JSON button container
        const jsonContainer = document.getElementById('jsonButtonContainer');
        if (jsonContainer) {
          jsonContainer.style.display = 'none';
        }
        break
      case 'finished':
        status = '研究完成！'
        setReportActionsStatus('enabled')
        isResearchActive = false;
        // Stop the research icon spinning
        updateResearchIcon(false);
        setResearchPanelsVisibility({ showProgress: true, showReport: true });

        // Show download panels and hide feature panels when research is finished
        showDownloadPanels();

        // Enable the copy button
        const copyButton = document.getElementById('copyToClipboard');
        if (copyButton) {
          copyButton.classList.remove('disabled');
        }

        // Show copy button in the header
        const topCopyButton = document.getElementById('copyToClipboardTop');
        if (topCopyButton) {
          topCopyButton.style.display = 'inline-block';
          topCopyButton.addEventListener('click', copyToClipboard);
        }

        // Show JSON button container
        const jsonButtonContainer = document.getElementById('jsonButtonContainer');
        if (jsonButtonContainer) {
          jsonButtonContainer.style.display = 'block';
        }

        // Show chat container when research is finished
        chatContainer = document.getElementById('chatContainer');
        if (chatContainer) {
          chatContainer.style.display = 'block';
          // Initialize chat if not already initialized
          initChat();
        }
        break
      case 'error':
        status = '研究失败！'
        setReportActionsStatus('disabled')
        isResearchActive = false;
        // Stop the research icon spinning
        updateResearchIcon(false);
        setResearchPanelsVisibility({ showProgress: true, showReport: false });
        break
      case 'initial':
        status = ''
        setReportActionsStatus('hidden')
        isResearchActive = false;
        // Make sure the research icon is not spinning initially
        updateResearchIcon(false);
        // Hide the copy button in the header
        const initialCopyBtnTop = document.getElementById('copyToClipboardTop');
        if (initialCopyBtnTop) {
          initialCopyBtnTop.style.display = 'none';
        }
        // Hide the JSON button container
        const initialJsonContainer = document.getElementById('jsonButtonContainer');
        if (initialJsonContainer) {
          initialJsonContainer.style.display = 'none';
        }
        setResearchPanelsVisibility({ showProgress: false, showReport: false });
        break
      default:
        setReportActionsStatus('disabled')
    }
    document.getElementById('status').innerHTML = status
    if (document.getElementById('status').innerHTML == '') {
      document.getElementById('status').style.display = 'none'
    } else {
      document.getElementById('status').style.display = 'block'
    }
  }

  /**
   * Shows or hides the download and copy buttons
   * @param {str} status Kind of hacky. Takes "enabled", "disabled", or "hidden". "Hidden is same as disabled but also hides the div"
   */
  const setReportActionsStatus = (status) => {
    const reportActions = document.getElementById('reportActions')
    // Disable everything in reportActions until research is finished

    if (status == 'enabled') {
      reportActions.querySelectorAll('a').forEach((link) => {
        link.classList.remove('disabled')
        link.removeAttribute('onclick')
        reportActions.style.display = 'block'
      })
    } else {
      reportActions.querySelectorAll('a').forEach((link) => {
        link.classList.add('disabled')
        link.setAttribute('onclick', 'return false;')
      })
      if (status == 'hidden') {
        reportActions.style.display = 'none'
      }
    }
  }

  const tagsInput = document.getElementById('tags-input');
  const input = document.getElementById('custom_source');

  const tags = [];

  const addTag = (url) => {
    if (tags.includes(url)) return;
    tags.push(url);

    const tagElement = document.createElement('span');
    tagElement.className = 'tag';
    tagElement.textContent = url;

    const removeButton = document.createElement('span');
    removeButton.className = 'remove-tag';
    removeButton.textContent = 'x';
    removeButton.onclick = function () {
      tagsInput.removeChild(tagElement);
      tags.splice(tags.indexOf(url), 1);
    };

    tagElement.appendChild(removeButton);
    tagsInput.insertBefore(tagElement, input);
  }

  const displaySelectedImages = (data) => {
    const imageContainer = document.getElementById('selectedImagesContainer')
    //imageContainer.innerHTML = '<h3>Selected Images</h3>'
    const images = JSON.parse(data.output)
    console.log("Received images:", images);  // Debug log
    if (images && images.length > 0) {
      images.forEach(imageUrl => {
        const imgElement = document.createElement('img')
        imgElement.src = imageUrl
        imgElement.alt = '研究图片'
        imgElement.style.maxWidth = '200px'
        imgElement.style.margin = '5px'
        imgElement.style.cursor = 'pointer'
        imgElement.onclick = () => showImageDialog(imageUrl)
        imageContainer.appendChild(imgElement)
      })
      imageContainer.style.display = 'block'
    } else {
      imageContainer.innerHTML += '<p>本次研究没有找到图片。</p>'
    }
  }

  const showImageDialog = (imageUrl) => {
    let dialog = document.querySelector('.image-dialog');
    if (!dialog) {
        dialog = document.createElement('div');
        dialog.className = 'image-dialog';

        const img = document.createElement('img');
        img.alt = '完整尺寸研究图片';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.className = 'close-btn'; // Added class for styling

        dialog.appendChild(img);
        dialog.appendChild(closeBtn);
        document.body.appendChild(dialog);

        closeBtn.onclick = () => {
            dialog.classList.remove('visible');
        };
        // Close on clicking backdrop
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.classList.remove('visible');
            }
        });
    }

    const imgElement = dialog.querySelector('img');
    imgElement.src = imageUrl;
    dialog.classList.add('visible');

    // Close with Escape key
    const escapeKeyListener = (e) => {
        if (e.key === 'Escape') {
            dialog.classList.remove('visible');
            document.removeEventListener('keydown', escapeKeyListener);
        }
    };
    document.addEventListener('keydown', escapeKeyListener);
}

  // Function to show download bar and enable buttons
  const showDownloadPanels = () => {
    // Show the bar by adding the visible class
    const stickyDownloadsBar = document.getElementById('stickyDownloadsBar');
    if (stickyDownloadsBar) {
      stickyDownloadsBar.classList.add('visible');
    }

    // Enable all download buttons
    const downloadButtons = document.querySelectorAll('.download-option-btn, .report-action-btn');
    downloadButtons.forEach(button => {
      button.classList.remove('disabled');
    });

    // Make top buttons report-actions section visible
    const reportActions = document.querySelector('.report-actions');
    if (reportActions) {
      reportActions.style.display = 'flex';
    }
  }

  // --- Storage Helpers (Cookies or LocalStorage) ---
  function setCookie(name, value, days) {
    if (name === 'conversationHistory') {
      try {
        localStorage.setItem(name, value);
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
        console.debug(`History saved to localStorage: ${name}`);
        return true;
      } catch (e) {
        console.error("Error saving history to localStorage:", e);
        if (!cookiesEnabled) {
          return false;
        }
      }
    }

    // Maximum cookie size is around 4KB (4096 bytes)
    const MAX_COOKIE_SIZE = 4000;

    // If cookies are disabled, use localStorage instead
    if (!cookiesEnabled) {
      try {
        localStorage.setItem(name, value);
        console.debug(`Data saved to localStorage: ${name}`);
        return true;
      } catch (e) {
        console.error("Error saving to localStorage:", e);
        return false;
      }
    }

    let expires = '';
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = '; expires=' + date.toUTCString();
    }

    // Encode the value
    const encodedValue = encodeURIComponent(value);

    // Calculate cookie size
    const cookieSize = (name + '=' + encodedValue + expires + '; path=/').length;
    console.debug(`Setting cookie: ${name}, size: ${cookieSize} bytes`);

    // If cookie is too large, display warning and truncate history
    if (cookieSize > MAX_COOKIE_SIZE) {
      console.warn(`Cookie size (${cookieSize} bytes) exceeds the ${MAX_COOKIE_SIZE} bytes limit!`);
      showToast('警告：历史记录过大，最早的记录将被移除。');

      if (name === 'conversationHistory') {
        try {
          // Parse, reduce entries, and try again
          const historyData = JSON.parse(value);
          if (Array.isArray(historyData) && historyData.length > 1) {
            // Remove the last entry and try again recursively
            const reducedHistory = historyData.slice(0, -1);
            console.debug(`Reducing history from ${historyData.length} to ${reducedHistory.length} entries`);
            setCookie(name, JSON.stringify(reducedHistory), days);
            return; // Exit after recursive call
          }
        } catch (e) {
          console.error('Could not parse history to reduce size:', e);
        }
      }

      return false; // Indicate failure
    }

    // Set the cookie
    document.cookie = name + '=' + encodedValue + expires + '; path=/';
    console.debug(`Cookie set: ${name}`);
    return true; // Indicate success
  }

  function getCookie(name) {
    console.debug(`Getting data: ${name}`);

    if (name === 'conversationHistory') {
      try {
        const storageValue = localStorage.getItem(name);
        if (storageValue) {
          console.debug(`History found in localStorage: ${name}, length: ${storageValue.length} chars`);
          return storageValue;
        }
      } catch (e) {
        console.error("Error retrieving history from localStorage:", e);
      }
    }

    // If cookies are disabled, use localStorage instead
    if (!cookiesEnabled) {
      try {
        const value = localStorage.getItem(name);
        if (value) {
          console.debug(`Data found in localStorage: ${name}, length: ${value.length} chars`);
          return value;
        }
        console.debug(`Data not found in localStorage: ${name}`);
        return null;
      } catch (e) {
        console.error("Error retrieving from localStorage:", e);
        return null;
      }
    }

    const nameEQ = name + '=';
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) == ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) == 0) {
        const value = decodeURIComponent(c.substring(nameEQ.length, c.length));
        console.debug(`Found cookie: ${name}, length: ${value.length} chars`);
        return value;
      }
    }
    console.debug(`Cookie not found: ${name}`);
    return null;
  }

  function deleteCookie(name) {
    console.debug(`Deleting storage: ${name}`);

    if (name === 'conversationHistory') {
      try {
        localStorage.removeItem(name);
      } catch (e) {
        console.error("Error removing history from localStorage:", e);
      }

      document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      return;
    }

    // If cookies are disabled, use localStorage instead
    if (!cookiesEnabled) {
      try {
        localStorage.removeItem(name);
        return;
      } catch (e) {
        console.error("Error removing from localStorage:", e);
        return;
      }
    }

    document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
  }
  // --- End Storage Helpers ---

  // Debug Helper - check cookie status
  const checkCookieStatus = () => {
    const storageData = localStorage.getItem('conversationHistory');
    if (storageData) {
      const byteSize = new Blob([storageData]).size;
      const kilobyteSize = (byteSize / 1024).toFixed(2);

      try {
        const parsed = JSON.parse(storageData);
        const entryCount = Array.isArray(parsed) ? parsed.length : 0;

        showToast(`正在使用 localStorage：${kilobyteSize}KB，${entryCount} 条情报历史`);
        console.debug(`LocalStorage size: ${byteSize} bytes, ${kilobyteSize}KB`);
        console.debug(`LocalStorage entries: ${entryCount}`);
      } catch (e) {
        showToast(`localStorage 中包含无效数据：${kilobyteSize}KB`);
        console.error('LocalStorage parse error:', e);
      }
      return;
    }

    const allCookies = document.cookie;
    console.debug('All cookies:', allCookies);

    const conversationCookie = getCookie('conversationHistory');
    if (conversationCookie) {
      const byteSize = new Blob([conversationCookie]).size;
      const kilobyteSize = (byteSize / 1024).toFixed(2);

      try {
        const parsed = JSON.parse(conversationCookie);
        const entryCount = Array.isArray(parsed) ? parsed.length : 0;

        showToast(`找到旧 Cookie：${kilobyteSize}KB，${entryCount} 条情报历史`);
        console.debug(`Cookie size: ${byteSize} bytes, ${kilobyteSize}KB`);
        console.debug(`Cookie entries: ${entryCount}`);
      } catch (e) {
        showToast(`找到 Cookie，但数据无效：${kilobyteSize}KB`);
        console.error('Cookie parse error:', e);
      }
    } else {
      showToast('没有找到情报历史存储');
    }
  }

  // Export history to a downloadable JSON file
  const exportHistory = () => {
    try {
      if (!conversationHistory || conversationHistory.length === 0) {
        showToast('没有可导出的情报历史');
        return;
      }

      // Create a formatted JSON string with pretty-printing
      const historyJson = JSON.stringify(conversationHistory, null, 2);

      // Create a Blob containing the data
      const blob = new Blob([historyJson], { type: 'application/json' });

      // Create an object URL for the blob
      const url = URL.createObjectURL(blob);

      // Create a temporary link element
      const link = document.createElement('a');
      link.href = url;

      // Set download attribute with filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.download = `daily-intel-history-${timestamp}.json`;

      // Append to the document
      document.body.appendChild(link);

      // Programmatically click the link to trigger the download
      link.click();

      // Clean up
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      showToast('情报历史已导出为 JSON 文件');
      console.debug('History exported, entries:', conversationHistory.length);
    } catch (error) {
      console.error('Error exporting history:', error);
      showToast('导出情报历史失败');
    }
  }

  // Trigger the file input for importing history
  const triggerImportHistory = () => {
    const fileInput = document.getElementById('historyFileInput');
    if (fileInput) {
      fileInput.click();
    } else {
      showToast('导入功能不可用');
    }
  }

  // Handle the file import for history
  const handleFileImport = (event) => {
    const file = event.target.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target.result;
        const importedData = JSON.parse(content);

        // Validate the imported data
        if (!Array.isArray(importedData)) {
          throw new Error('导入数据不是数组');
        }

        // Check if each entry has the required fields
        const validEntries = importedData.filter(entry => {
          return entry &&
            typeof entry === 'object' &&
            (entry.prompt || entry.task) && // Allow both prompt and legacy task field
            (entry.links || entry.downloadLinks); // Allow both links and legacy downloadLinks
        });

        if (validEntries.length === 0) {
          showToast('导入文件中没有有效的情报历史');
          return;
        }

        // Map the entries to the current structure if needed
        const mappedEntries = validEntries.map(entry => {
          return {
            id: entry.id || `imported-${entry.timestamp || Date.now()}`,
            title: entry.title || '',
            prompt: entry.prompt || entry.task || '',
            content: entry.content || '',
            links: entry.links || entry.downloadLinks || {},
            reportType: entry.reportType || '',
            reportSource: entry.reportSource || '',
            tone: entry.tone || '',
            queryDomains: entry.queryDomains || [],
            timestamp: entry.timestamp || new Date().toISOString()
          };
        });

        // Confirm before overwriting existing history
        if (conversationHistory && conversationHistory.length > 0) {
          if (confirm(`当前已有 ${conversationHistory.length} 条情报历史。请选择：
- 点击“确定”：将导入记录合并到现有历史
- 点击“取消”：用导入记录替换全部现有历史`)) {
            // Merge with existing history
            conversationHistory = [...mappedEntries, ...conversationHistory];
          } else {
            // Replace existing history
            conversationHistory = mappedEntries;
          }
        } else {
          // No existing history, just set the imported data
          conversationHistory = mappedEntries;
        }

        // Save the new history and update the UI
        saveConversationHistory();
        renderHistoryEntries();

        showToast(`成功导入 ${validEntries.length} 条情报历史`);
        console.debug('Research history imported, valid entries:', validEntries.length);

      } catch (error) {
        console.error('Error importing history:', error);
        showToast('导入情报历史失败：文件格式无效');
      }

      // Reset the file input so the same file can be selected again
      event.target.value = '';
    };

    reader.onerror = () => {
      console.error('Error reading file');
      showToast('读取导入文件失败');
      event.target.value = '';
    };

    reader.readAsText(file);
  }

  // Initialize chat functionality
  const initChat = () => {
    const chatInput = document.getElementById('chatInput');
    const sendChatBtn = document.getElementById('sendChatBtn');
    const voiceInputBtn = document.getElementById('voiceInputBtn');

    if (!chatInput || !sendChatBtn) return;

    // Clear previous messages
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
      chatMessages.innerHTML = '';
    }

    // Add event listeners for chat input
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    sendChatBtn.addEventListener('click', sendChatMessage);

    // Initialize speech recognition if supported
    if (voiceInputBtn) {
      initSpeechRecognition(voiceInputBtn, chatInput);
    }

    // Auto-resize textarea as content grows
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = (chatInput.scrollHeight) + 'px';
    });

    // Add welcome message
    addChatMessage('我可以继续回答关于这份研究报告的问题。你想了解什么？', false);
  }

  // Initialize speech recognition
  const initSpeechRecognition = (button, inputElement) => {
    // Check if browser supports speech recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn('Speech recognition not supported in this browser');
      button.style.display = 'none';
      return;
    }

    const recognition = new SpeechRecognition();

    // Configure speech recognition
    recognition.continuous = false;
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let isListening = false;
    let finalTranscript = '';

    // Add event listeners for speech recognition
    recognition.onstart = () => {
      isListening = true;
      finalTranscript = '';
      button.classList.add('listening');
      button.innerHTML = '<i class="fas fa-microphone-slash"></i>';
      button.title = '停止收听';

      // Show visual feedback
      showToast('正在听...', 1000);
    };

    recognition.onresult = (event) => {
      let interimTranscript = '';

      // Loop through the results
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      // Update the input element with the transcription
      inputElement.value = finalTranscript + interimTranscript;

      // Trigger input event to resize textarea
      const inputEvent = new Event('input', { bubbles: true });
      inputElement.dispatchEvent(inputEvent);
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error', event.error);
      resetRecognition();

      if (event.error === 'not-allowed') {
        showToast('麦克风访问被拒绝，请在浏览器设置中允许麦克风权限。', 3000);
      } else {
        showToast('语音识别错误：' + event.error, 3000);
      }
    };

    recognition.onend = () => {
      resetRecognition();
    };

    // Reset the recognition state
    const resetRecognition = () => {
      isListening = false;
      button.classList.remove('listening');
      button.innerHTML = '<i class="fas fa-microphone"></i>';
      button.title = '使用语音输入';
    };

    // Toggle speech recognition on button click
    button.addEventListener('click', () => {
      if (isListening) {
        recognition.stop();
      } else {
        recognition.start();
      }
    });
  };

  // Create a new function to handle WebSocket reconnection
  const reconnectWebSocket = (message = null) => {
    // Don't attempt too many reconnections
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.error(`Failed to reconnect after ${maxReconnectAttempts} attempts`);
      addChatMessage(`重连 ${maxReconnectAttempts} 次后仍失败，请刷新页面。`, false);
      return false;
    }

    reconnectAttempts++;

    // Calculate backoff time (exponential backoff)
    const backoff = reconnectInterval * Math.pow(1.5, reconnectAttempts - 1);
    console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts}) in ${backoff}ms...`);

    // Show reconnection status to user
    addChatMessage(`连接已断开，正在尝试重连（${reconnectAttempts}/${maxReconnectAttempts}）...`, false);

    // Try to reconnect after delay
    setTimeout(() => {
      try {
        // Setup new WebSocket connection
        dispose_socket = listenToSockEvents();

        // Set up a one-time handler to send the message after reconnection
        if (message) {
          const messageToSend = message;
          const checkConnectionAndSend = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
              console.log("Reconnected successfully, sending queued message");
              socket.send(messageToSend);
              return true;
            } else if (reconnectAttempts < maxReconnectAttempts) {
              console.log("Socket not ready yet, retrying...");
              setTimeout(checkConnectionAndSend, 1000);
              return false;
            }
            return false;
          };

          setTimeout(checkConnectionAndSend, 1000);
        }

        return true;
      } catch (e) {
        console.error("Error during reconnection:", e);
        return false;
      }
    }, backoff);

    return true;
  };

  // Send a chat message
  const sendChatMessage = () => {
    const chatInput = document.getElementById('chatInput');
    if (!chatInput || !chatInput.value.trim()) return;

    const message = chatInput.value.trim();

    // Add user message to chat
    addChatMessage(message, true);

    // Clear input
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Add loading indicator
    const loadingId = addLoadingIndicator();

    // Prepare the message to send
    const messageToSend = `chat ${JSON.stringify({ message: message })}`;

    // Send message through WebSocket
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(messageToSend);
    } else {
      // If socket is closed, try to reconnect
      removeLoadingIndicator(loadingId);

      // Reset reconnect attempts if this is a new chat session
      if (reconnectAttempts >= maxReconnectAttempts) {
        reconnectAttempts = 0;
      }

      // Attempt to reconnect and queue the message to be sent after reconnection
      if (!reconnectWebSocket(messageToSend)) {
        // If reconnection fails or max attempts reached
        addChatMessage('无法发送消息，连接不可用。', false);
      }
    }
  }

  // Add a chat message to the UI
  const addChatMessage = (message, isUser = false) => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${isUser ? 'user-message' : 'ai-message'}`;

    // Process message for AI responses (convert markdown to HTML for AI messages)
    let processedMessage = message;
    if (!isUser) {
      // Use showdown for markdown conversion
      const converter = new showdown.Converter({
        ghCodeBlocks: true,
        tables: true,
        tasklists: true,
        openLinksInNewWindow: true
      });
      processedMessage = converter.makeHtml(message);
    }

    // Set message content
    messageEl.innerHTML = isUser ? escapeHtml(processedMessage) : processedMessage;

    // Add timestamp
    const timestampEl = document.createElement('div');
    timestampEl.className = 'chat-timestamp';
    const now = new Date();
    timestampEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messageEl.appendChild(timestampEl);

    // Add to chat container
    chatMessages.appendChild(messageEl);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Add a loading indicator
  const addLoadingIndicator = () => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return null;

    const loadingId = 'loading-' + Date.now();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'chat-message ai-message chat-loading';
    loadingEl.id = loadingId;

    // Create the dots
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'chat-dot';
      loadingEl.appendChild(dot);
    }

    chatMessages.appendChild(loadingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    return loadingId;
  }

  // Remove loading indicator
  const removeLoadingIndicator = (loadingId) => {
    if (!loadingId) return;

    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) {
      loadingEl.remove();
    }
  }

  // Escape HTML to prevent XSS in user messages
  const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize expand buttons
  const initExpandButtons = () => {
    // Report container expand button
    const expandReportBtn = document.getElementById('expandReportBtn');
    if (expandReportBtn) {
      expandReportBtn.addEventListener('click', () => {
        const reportContainer = document.querySelector('.report-container');
        toggleExpand(reportContainer);
      });
    }

    // Chat container expand button
    const expandChatBtn = document.getElementById('expandChatBtn');
    if (expandChatBtn) {
      expandChatBtn.addEventListener('click', () => {
        const chatContainer = document.getElementById('chatContainer');
        toggleExpand(chatContainer);
      });
    }

    // Output container expand button
    const expandOutputBtn = document.getElementById('expandOutputBtn');
    if (expandOutputBtn) {
      expandOutputBtn.addEventListener('click', () => {
        const outputContainer = document.querySelector('.research-output-container');
        toggleExpand(outputContainer);
      });
    }

    // Close expanded view when ESC key is pressed
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const expandedElements = document.querySelectorAll('.expanded-view');
        expandedElements.forEach(el => {
          // Reset the button icon
          const button = el.querySelector('.expand-button i');
          if (button) {
            button.classList.remove('fa-compress-alt');
            button.classList.add('fa-expand-alt');
          }

          // Reset content container styles
          const contentContainers = el.querySelectorAll('#reportContainer, #output, #chatMessages');
          contentContainers.forEach(container => {
            if (container) {
              container.style.maxHeight = '';
            }
          });

          // Remove expanded-view class
          el.classList.remove('expanded-view');
        });
      }
    });
  }

  // Toggle expand mode for an element
  const toggleExpand = (element) => {
    if (!element) return;

    // Toggle expanded-view class
    element.classList.toggle('expanded-view');

    // Change button icon and title based on state
    const buttonIcon = element.querySelector('.expand-button i');
    const button = element.querySelector('.expand-button');

    if (buttonIcon && button) {
      if (element.classList.contains('expanded-view')) {
        buttonIcon.classList.remove('fa-compress-alt');
        buttonIcon.classList.add('fa-compress-alt');
        button.title = '收起'; // Update title to Collapse

        // Find content containers and expand their height
        const contentContainers = element.querySelectorAll('#reportContainer, #output, #chatMessages');
        contentContainers.forEach(container => {
          if (container) {
            // Set expanded heights - no positioning changes
            if (container.id === 'reportContainer') {
              container.style.maxHeight = '800px'; // Fixed expanded height for report
            } else {
              container.style.maxHeight = '600px'; // Fixed expanded height for other content
            }
          }
        });
      } else {
        buttonIcon.classList.remove('fa-compress-alt');
        buttonIcon.classList.add('fa-expand-alt');
        button.title = '展开'; // Update title to Expand

        // Reset heights back to original when collapsed
        const contentContainers = element.querySelectorAll('#reportContainer, #output, #chatMessages');
        contentContainers.forEach(container => {
          if (container) {
            container.style.maxHeight = '';
          }
        });
      }
    }
  }

  // MCP Configuration Management
  
  // Initialize MCP functionality
  const initMCPSection = () => {
    const mcpEnabled = document.getElementById('mcpEnabled');
    const mcpConfigSection = document.getElementById('mcpConfigSection');
    const mcpInfoBtn = document.getElementById('mcpInfoBtn');
    const mcpConfig = document.getElementById('mcpConfig');
    const mcpFormatBtn = document.getElementById('mcpFormatBtn');
    const mcpExampleLink = document.getElementById('mcpExampleLink');

    if (!mcpEnabled || !mcpConfigSection) {
      console.warn('MCP elements not found');
      return;
    }

    // Toggle MCP config section
    mcpEnabled.addEventListener('change', () => {
      if (mcpEnabled.checked) {
        mcpConfigSection.style.display = 'block';
        updateRetrieverForMCP(true);
      } else {
        mcpConfigSection.style.display = 'none';
        updateRetrieverForMCP(false);
      }
    });

    // MCP info modal
    if (mcpInfoBtn) {
      mcpInfoBtn.addEventListener('click', showMCPInfo);
    }

    // JSON validation and formatting
    if (mcpConfig) {
      mcpConfig.addEventListener('input', validateMCPConfig);
      mcpConfig.addEventListener('blur', validateMCPConfig);
    }

    if (mcpFormatBtn) {
      mcpFormatBtn.addEventListener('click', formatMCPConfig);
    }

    if (mcpExampleLink) {
      mcpExampleLink.addEventListener('click', (e) => {
        e.preventDefault();
        showMCPExample();
      });
    }

    // Preset buttons
    const presetButtons = document.querySelectorAll('.preset-btn');
    presetButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const preset = e.currentTarget.dataset.preset;
        addMCPPreset(preset);
      });
    });

    // Create MCP info modal
    createMCPInfoModal();

    // Initial validation
    validateMCPConfig();
  };

  // Validate MCP JSON configuration
  const validateMCPConfig = () => {
    const mcpConfig = document.getElementById('mcpConfig');
    const mcpConfigStatus = document.getElementById('mcpConfigStatus');
    
    if (!mcpConfig || !mcpConfigStatus) return;

    const configText = mcpConfig.value.trim();
    
    if (!configText || configText === '[]') {
      mcpConfig.className = 'form-control mcp-config-textarea';
      mcpConfigStatus.textContent = '配置为空';
      mcpConfigStatus.className = 'mcp-status-text';
      return true;
    }

    try {
      const parsed = JSON.parse(configText);
      
      if (!Array.isArray(parsed)) {
        throw new Error('配置必须是数组');
      }

      // Validate each server config
      const errors = [];
      parsed.forEach((server, index) => {
        if (!server.name) {
          errors.push(`服务器 ${index + 1}：缺少 name`);
        }
        if (!server.command && !server.connection_url) {
          errors.push(`服务器 ${index + 1}：缺少 command 或 connection_url`);
        }
      });

      if (errors.length > 0) {
        throw new Error(errors.join('; '));
      }

      mcpConfig.className = 'form-control mcp-config-textarea valid';
      mcpConfigStatus.textContent = `JSON 有效 ✓（${parsed.length} 个服务器）`;
      mcpConfigStatus.className = 'mcp-status-text valid';
      return true;

    } catch (error) {
      mcpConfig.className = 'form-control mcp-config-textarea invalid';
      mcpConfigStatus.textContent = `JSON 无效：${error.message}`;
      mcpConfigStatus.className = 'mcp-status-text invalid';
      return false;
    }
  };

  // Format MCP JSON configuration
  const formatMCPConfig = () => {
    const mcpConfig = document.getElementById('mcpConfig');
    if (!mcpConfig) return;

    try {
      const parsed = JSON.parse(mcpConfig.value.trim() || '[]');
      mcpConfig.value = JSON.stringify(parsed, null, 2);
      validateMCPConfig();
      showToast('JSON 格式化成功！');
    } catch (error) {
      showToast('无法格式化无效 JSON');
    }
  };

  // Show MCP configuration example
  const showMCPExample = () => {
    const exampleConfig = [
      {
        "name": "github",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {
          "GITHUB_PERSONAL_ACCESS_TOKEN": "your_github_token_here"
        }
      },
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"],
        "env": {}
      }
    ];

    const mcpConfig = document.getElementById('mcpConfig');
    if (mcpConfig) {
      mcpConfig.value = JSON.stringify(exampleConfig, null, 2);
      validateMCPConfig();
      showToast('示例配置已载入！');
    }
  };

  // Update retriever configuration for MCP
  const updateRetrieverForMCP = (enableMCP) => {
    if (enableMCP) {
      showToast('MCP 已启用，将加入研究流程');
    } else {
      showToast('MCP 已关闭，仅使用网络搜索');
    }
  };

  // Show MCP information modal
  const showMCPInfo = () => {
    const modal = document.getElementById('mcpInfoModal');
    if (modal) {
      modal.classList.add('visible');
    }
  };

  // Create MCP info modal
  const createMCPInfoModal = () => {
    if (document.getElementById('mcpInfoModal')) return;

    const modal = document.createElement('div');
    modal.id = 'mcpInfoModal';
    modal.className = 'mcp-info-modal';
    
    modal.innerHTML = `
      <div class="mcp-info-content">
        <button class="mcp-info-close" onclick="closeMCPInfo()">
          <i class="fas fa-times"></i>
        </button>
        <h3>模型上下文协议（MCP）</h3>
        <p>MCP 让每日情报速递可以通过标准协议连接外部工具和数据源。</p>
        
        <h4 class="highlight">优势：</h4>
        <ul>
          <li><span class="highlight">访问本地数据：</span>连接数据库、文件系统和 API</li>
          <li><span class="highlight">使用外部工具：</span>集成 Web 服务和第三方工具</li>
          <li><span class="highlight">扩展能力：</span>通过 MCP 服务器添加自定义功能</li>
          <li><span class="highlight">保持安全：</span>通过认证控制访问范围</li>
        </ul>

        <h4 class="highlight">快速开始：</h4>
        <ul>
          <li>勾选上方复选框启用 MCP</li>
          <li>点击预设，将预配置服务器加入 JSON</li>
          <li>也可以粘贴自己的 MCP JSON 数组配置</li>
          <li>开始研究后，MCP 会随研究流程一起运行</li>
        </ul>

        <h4 class="highlight">配置格式：</h4>
        <p>每个 MCP 服务器应是一个 JSON 对象，并包含以下属性：</p>
        <ul>
          <li><span class="highlight">name：</span>唯一标识，例如 "github"、"filesystem"</li>
          <li><span class="highlight">command：</span>启动服务器的命令，例如 "npx"、"python"</li>
          <li><span class="highlight">args：</span>参数数组，例如 ["-y", "@modelcontextprotocol/server-github"]</li>
          <li><span class="highlight">env：</span>环境变量对象，例如 {"API_KEY": "your_key"}</li>
        </ul>
      </div>
    `;

    document.body.appendChild(modal);

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('visible');
      }
    });

    // Close with Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('visible')) {
        modal.classList.remove('visible');
      }
    });
  };

  // Close MCP info modal
  window.closeMCPInfo = () => {
    const modal = document.getElementById('mcpInfoModal');
    if (modal) {
      modal.classList.remove('visible');
    }
  };

  // Add MCP preset configurations
  const addMCPPreset = (preset) => {
    const presets = {
      github: {
        "name": "github",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {
          "GITHUB_PERSONAL_ACCESS_TOKEN": "your_github_token_here"
        }
      },
      tavily: {
        "name": "tavily",
        "command": "npx",
        "args": ["-y", "tavily-mcp@0.1.2"],
        "env": {
          "TAVILY_API_KEY": "your_tavily_api_key_here"
        }
      },
      filesystem: {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"],
        "env": {}
      }
    };

    const config = presets[preset];
    if (!config) return;

    const mcpConfig = document.getElementById('mcpConfig');
    if (!mcpConfig) return;

    try {
      let currentConfig = [];
      const currentText = mcpConfig.value.trim();
      
      if (currentText && currentText !== '[]') {
        currentConfig = JSON.parse(currentText);
      }

      // Check if server already exists
      const existingIndex = currentConfig.findIndex(server => server.name === config.name);
      
      if (existingIndex !== -1) {
        // Replace existing server
        currentConfig[existingIndex] = config;
        showToast(`已更新 ${preset} MCP 服务器配置`);
      } else {
        // Add new server
        currentConfig.push(config);
        showToast(`已添加 ${preset} MCP 服务器配置`);
      }

      mcpConfig.value = JSON.stringify(currentConfig, null, 2);
      validateMCPConfig();

    } catch (error) {
      console.error('Error adding preset:', error);
      showToast('添加预设配置失败');
    }
  };

  // Collect MCP configuration data
  const collectMCPData = () => {
    const mcpEnabled = document.getElementById('mcpEnabled');
    if (!mcpEnabled || !mcpEnabled.checked) {
      return null;
    }

    const mcpConfig = document.getElementById('mcpConfig');
    
    if (!mcpConfig) {
      console.warn('MCP config element not found for data collection');
      return null;
    }

    // Validate configuration before collecting
    if (!validateMCPConfig()) {
      showToast('MCP 配置无效，请修复错误后再提交');
      return null;
    }

    try {
      const configText = mcpConfig.value.trim();
      const mcpConfigs = configText && configText !== '[]' ? JSON.parse(configText) : [];

      return {
        mcp_enabled: true,
        mcp_strategy: "fast", // Always use "fast" strategy as default
        mcp_configs: mcpConfigs
      };
    } catch (error) {
      console.error('Error collecting MCP data:', error);
      showToast('处理 MCP 配置失败');
      return null;
    }
  };

  return {
    init,
    startResearch,
    addTag,
    copyToClipboard,
    displaySelectedImages,
    showImageDialog,
    checkCookieStatus,
    exportHistory,
    importHistory: triggerImportHistory,  // Add import function to return object
    initChat,
    sendChatMessage,
    addChatMessage
  }
})()

window.addEventListener('DOMContentLoaded', DailyIntelBriefing.init)
