/*
 * 美团响应净化，配套 MT-Loon.plugin，2026-10-30。
 * 根据用户给定的 MT.snippet / MT.js / MT-Clean.plugin / MT-NoAds.plugin
 * 中的接口和字段重新实现防御性处理；原规则作者 TG@ZenMoFiShi，Loon 参考 n4bix。
 * 只做本地响应处理，不发送网络请求、不存储凭证、不输出请求或响应内容。
 * 非目标 URL、非 200 响应、非 JSON、未知结构或异常均原样放行。
 * 没有真机抓包，因此不承诺覆盖所有版本或广告位。
 */

(function () {
    "use strict";

    var result = {};

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function parseResponseJson(text) {
        // 跳过字符串令牌，避免把字符串形式的订单 ID 当成数字。
        // JSON.parse/stringify 会损失超出 JS 安全整数范围的数值精度，发现时不净化。
        var tokens = /"(?:\\.|[^"\\])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
        var token;
        while ((token = tokens.exec(text)) !== null) {
            if (token[1] === undefined) continue;
            var value = Number(token[1]);
            var mantissa = token[1].split(/[eE]/)[0];
            if (!isFinite(value) || Math.abs(value) > 9007199254740991 ||
                (value === 0 && /[1-9]/.test(mantissa))) {
                throw new Error("Unsafe JSON number");
            }
        }
        return JSON.parse(text);
    }

    function clearArray(holder, key) {
        if (!isObject(holder) || !Array.isArray(holder[key]) || holder[key].length === 0) {
            return false;
        }
        holder[key] = [];
        return true;
    }

    function cleanTabs(root) {
        var resource = isObject(root.data) ? root.data.resource : null;
        if (!isObject(resource) || !Array.isArray(resource.tabArea)) return false;

        var hasHome = false;
        var hasMine = false;
        resource.tabArea.forEach(function (tab) {
            if (!isObject(tab)) return;
            if (tab.tabName === "homepage") hasHome = true;
            if (tab.tabName === "mine") hasMine = true;
        });
        // 结构发生变化时不删底栏，避免丢失主要导航。
        if (!hasHome || !hasMine) return false;

        var kept = resource.tabArea.filter(function (tab) {
            return !isObject(tab) || (tab.tabName !== "video" && tab.tabName !== "xiaotuan");
        });
        if (kept.length === resource.tabArea.length) return false;
        resource.tabArea = kept;
        return true;
    }

    function cleanFeed(root) {
        if (!Array.isArray(root.data)) return false;
        // 不把已有的未知 ext 类型覆盖为对象。
        if (root.ext !== undefined && root.ext !== null && !isObject(root.ext)) return false;
        var changed = root.data.length !== 0 || root.bottom !== true ||
            !isObject(root.ext) || root.ext.forbidByExp !== true;
        if (!changed) return false;
        root.data = [];
        root.bottom = true;
        if (!isObject(root.ext)) root.ext = {};
        root.ext.forbidByExp = true;
        return true;
    }

    function cleanMine(root) {
        if (!Array.isArray(root.children)) return false;
        var kept = root.children.filter(function (child) {
            return !isObject(child) || child.name !== "mine_cross_recommend";
        });
        if (kept.length === root.children.length) return false;
        root.children = kept;
        return true;
    }

    function cleanDefaultWord(root) {
        var introduce = root.searchIntroduceResponse;
        if (!isObject(introduce)) return false;
        var changed = clearArray(introduce.defaultWordRes, "defaultWordItems");
        if (clearArray(introduce, "HotWordInfos")) changed = true;
        return changed;
    }

    function cleanHotWords(root) {
        var data = root.data;
        if (!isObject(data)) return false;
        var changed = false;
        if (Array.isArray(data.segmentsV2)) {
            var kept = [];
            data.segmentsV2.forEach(function (segment) {
                if (!isObject(segment) || !Array.isArray(segment.hotwordSegments)) {
                    kept.push(segment);
                    return;
                }
                var words = segment.hotwordSegments.filter(function (word) {
                    return !isObject(word) ||
                        (word.pageName !== "EntranceHotwordsV2Hotwords" &&
                         word.pageName !== "EntranceHotwordsV2ContentCard");
                });
                if (words.length === segment.hotwordSegments.length) {
                    kept.push(segment);
                } else {
                    changed = true;
                    if (words.length !== 0) {
                        segment.hotwordSegments = words;
                        kept.push(segment);
                    }
                }
            });
            if (changed) data.segmentsV2 = kept;
        }
        // 搜索气泡独立处理，不要求 segmentsV2 同时存在。
        if (clearArray(data.aiSearchBubble, "bubbleTexts")) changed = true;
        return changed;
    }

    function cleanAiSkills(root) {
        var isString = typeof root.data === "string";
        var data = isString ? parseResponseJson(root.data) : root.data;
        if (!isObject(data) || !isObject(data.skills) || Object.keys(data.skills).length === 0) {
            return false;
        }
        data.skills = {};
        root.data = isString ? JSON.stringify(data) : data;
        return true;
    }

    function cleanResourceArea(root, area) {
        var changed = false;
        [root, root.data].forEach(function (holder) {
            if (!isObject(holder)) return;
            [holder.resourcesMap, holder.resource].forEach(function (resource) {
                if (clearArray(resource, area)) changed = true;
            });
        });
        return changed;
    }

    function cleanCartBanner(root) {
        return cleanResourceArea(root, "topBannerArea");
    }

    function cleanSplash(root) {
        return cleanResourceArea(root, "startupPicArea");
    }

    // 与插件的 9 条 URL Guard 一一对应；同时固定域名、完整路径和路径结束边界。
    var routes = [
        { url: /^https?:\/\/apimobile\.meituan\.com\/aggroup\/indexTab\/?(?:\?|$)/i, run: cleanTabs },
        { url: /^https?:\/\/feedguess\.meituan\.com\/lycoris\/scene\/gwc_feed1_2265\/?(?:\?|$)/i, run: cleanFeed },
        { url: /^https?:\/\/feedguess\.meituan\.com\/lycoris\/scene\/personalcenter_2154\/?(?:\?|$)/i, run: cleanFeed },
        { url: /^https?:\/\/mt-personalcenter\.meituan\.com\/usercenter\/display\/?(?:\?|$)/i, run: cleanMine },
        { url: /^https?:\/\/apimobile\.meituan\.com\/group\/v1\/deal\/searchpage\/defaultword\/?(?:\?|$)/i, run: cleanDefaultWord },
        { url: /^https?:\/\/apimobile\.meituan\.com\/group\/v1\/deal\/searchpage\/hotword\/city\/divide\/hotrecommend\/?(?:\?|$)/i, run: cleanHotWords },
        { url: /^https?:\/\/assistify\.meituan\.com\/assistant\/getAppClientHornConfig\/?(?:\?|$)/i, run: cleanAiSkills },
        { url: /^https?:\/\/mop\.meituan\.com\/mop\/entry\/shoppingCartEntry\/?(?:\?|$)/i, run: cleanCartBanner },
        { url: /^https?:\/\/mop\.meituan\.com\/api\/entryModule\/startupPicture\/?(?:\?|$)/i, run: cleanSplash }
    ];

    try {
        var request = typeof $request === "undefined" ? null : $request;
        var response = typeof $response === "undefined" ? null : $response;
        if (request && response && typeof request.url === "string" &&
            Number(response.status) === 200 && typeof response.body === "string" &&
            response.body.length !== 0) {
            for (var index = 0; index < routes.length; index += 1) {
                if (!routes[index].url.test(request.url)) continue;
                var root = parseResponseJson(response.body.replace(/^\uFEFF/, ""));
                if (isObject(root) && routes[index].run(root)) {
                    result = { body: JSON.stringify(root) };
                }
                break;
            }
        }
    } catch (error) {
        // 所有修改只作用于临时解析对象；失败后提交空对象，保留原响应字节。
        result = {};
        try {
            if (typeof console !== "undefined" && console && typeof console.log === "function") {
                console.log("[MT-Loon] 响应处理失败，已原样放行。");
            }
        } catch (loggingError) {
            // 日志不是必要步骤，日志失败也不能阻止 $done。
        }
    }

    // 放在 try/catch 之外：只调用一次，且不会把 Loon 的结束信号误当处理异常。
    $done(result);
})();
