/**
 * 调用本地 Crawl4AI 服务，获取渲染后的页面 HTML。
 */

const CRAWL4AI_ENDPOINT = 'http://127.0.0.1:11235/crawl';
const REQUEST_TIMEOUT_MS = 20000;

export async function fetchCrawl4AIPageContent(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(CRAWL4AI_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url }),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data || !data.html) {
            throw new Error(data?.error || '本地服务未返回有效 HTML');
        }

        return {
            title: data.title || '',
            html: data.html || ''
        };
    } catch (error) {
        console.warn('Crawl4AI 服务调用失败:', error);
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}
