(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = { basis: "peg", group: "all", q: "", coreOnly: false, sortK: "vs", asc: true, sel: null };
  let D = null, bySym = {}, groupName = {}, buysBySym = {}, medians = {};

  // ---------- formatting
  const fmtMoney = (v) => v == null ? "—" : "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtBig = (v) => {
    if (v == null) return "—";
    const a = Math.abs(v);
    if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(0) + "K";
    return "$" + v.toFixed(0);
  };
  const fmtNum = (v, d = 2) => v == null ? '<span class="na">n/a</span>' : v.toFixed(d);
  const fmtDate = (s) => s ? new Date(s + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
  const median = (arr) => {
    const a = arr.filter((v) => v != null).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  // ---------- theme
  try { const t = localStorage.getItem("wof-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  $("#theme").onclick = () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("wof-theme", next); } catch (e) {}
  };

  // ---------- data
  fetch("data/snapshot.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch((e) => { $("#updated").textContent = "Data unavailable (" + e.message + ")"; $("#dot").classList.add("stale"); });

  function init(data) {
    D = data;
    D.groups.forEach((g) => (groupName[g.id] = g.name));
    D.tickers.forEach((t) => (bySym[t.symbol] = t));
    D.insider_buys.forEach((b) => (buysBySym[b.symbol] ||= []).push(b));
    D.tickers.forEach((t) => {
      const list = buysBySym[t.symbol] || [];
      t.buycount = list.length;
      t.buyval = list.reduce((s, b) => s + (b.value || 0), 0) || null;
    });

    $("#sample").hidden = !D.sample;
    // Forward PEG needs analyst estimates; hide the toggle when the data source doesn't provide them.
    const hasFwd = D.tickers.some((t) => t.fwd_peg != null);
    if (!hasFwd) $("#basis").hidden = true;
    [...$("#basis").children].forEach((c) => c.classList.toggle("on", c.dataset.b === state.basis));
    if (D.valuation_source) $("#src").textContent = D.valuation_source;
    if (D.peg_method) $("#method").textContent = D.peg_method + ".";
    const gen = new Date(D.generated_at);
    $("#updated").textContent = (D.sample ? "Sample · " : "Updated ") +
      gen.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
    if (!D.sample && Date.now() - gen.getTime() > 4 * 86400e3) $("#dot").classList.add("stale");
    $("#insSub").textContent += ` Last ${D.insider_lookback_days || 90} days.`;

    // chips
    const hasMag7 = D.tickers.some((t) => (t.tags || []).includes("mag7"));
    const chips = [{ id: "all", name: "All" }, ...(hasMag7 ? [{ id: "mag7", name: "Mag 7" }] : []), ...D.groups];
    $("#chips").innerHTML = chips.map((g) => `<button class="chip${g.id === "all" ? " on" : ""}" data-g="${g.id}">${esc(g.name)}</button>`).join("");
    $("#chips").onclick = (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      state.group = b.dataset.g;
      [...$("#chips").children].forEach((c) => c.classList.toggle("on", c === b));
      render();
    };
    $("#basis").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.basis = b.dataset.b;
      [...$("#basis").children].forEach((c) => c.classList.toggle("on", c === b));
      computeMedians(); render();
    };
    $("#q").oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); render(); };
    $("#coreOnly").onchange = (e) => { state.coreOnly = e.target.checked; render(); };
    document.querySelectorAll("#tbl th.sortable").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.k;
        if (state.sortK === k) state.asc = !state.asc;
        else { state.sortK = k; state.asc = ["symbol", "group", "vs", "basis", "pe"].includes(k); }
        render();
      };
    });
    $("#tbl tbody").onclick = (e) => {
      const tr = e.target.closest("tr[data-s]"); if (!tr) return;
      state.sel = state.sel === tr.dataset.s ? null : tr.dataset.s;
      render();
      if (state.sel) $("#detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    computeMedians();
    render();
    renderInsiders();
  }

  // Peer median = median of every ticker in the same peer group (core + peers).
  function computeMedians() {
    medians = {};
    D.groups.forEach((g) => (medians[g.id] = median(g.tickers.map((s) => bySym[s]?.[state.basis]))));
    D.tickers.forEach((t) => {
      const v = t[state.basis], m = medians[t.group];
      t.basis = v ?? null;
      t.vs = v != null && m ? (v / m - 1) * 100 : null;
    });
  }

  function rows() {
    let r = D.tickers.filter((t) =>
      (state.group === "all" || t.group === state.group || (state.group === "mag7" && (t.tags || []).includes("mag7"))) &&
      (!state.coreOnly || t.role === "core") &&
      (!state.q || t.symbol.toLowerCase().includes(state.q) || t.name.toLowerCase().includes(state.q)));
    const k = state.sortK, dir = state.asc ? 1 : -1;
    r.sort((a, b) => {
      let x = k === "group" ? groupName[a.group] : a[k], y = k === "group" ? groupName[b.group] : b[k];
      if (x == null && y == null) return a.symbol.localeCompare(b.symbol);
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    return r;
  }

  function render() {
    renderKpis();
    document.querySelectorAll("#tbl th.sortable").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.k === state.sortK);
      th.classList.toggle("asc", th.dataset.k === state.sortK && state.asc);
    });
    const r = rows();
    $("#tbl tbody").innerHTML = r.length ? r.map((t) => {
      const chg = t.change_pct == null ? "" : `<span class="${t.change_pct >= 0 ? "up" : "down"}"> ${t.change_pct >= 0 ? "+" : ""}${t.change_pct.toFixed(1)}%</span>`;
      let vs = '<span class="na">—</span>';
      if (t.vs != null) {
        const cls = t.vs <= -10 ? "cheap" : t.vs >= 10 ? "rich" : "";
        vs = `<span class="pill ${cls}">${t.vs > 0 ? "+" : ""}${t.vs.toFixed(0)}%</span>`;
      }
      const buys = t.buycount ? `<span class="buys"><b>${fmtBig(t.buyval)}</b> (${t.buycount})</span>` : '<span class="na">—</span>';
      return `<tr data-s="${t.symbol}" class="${state.sel === t.symbol ? "sel" : ""}">
        <td><span class="sym">${t.symbol}</span><span class="nm" title="${esc(t.name)}">${esc(t.name)}</span>${t.role === "core" ? '<span class="tag core">growth</span>' : ""}</td>
        <td class="left grp hide-sm">${esc(groupName[t.group])}</td>
        <td class="hide-sm">${fmtMoney(t.price)}${chg}</td>
        <td class="hide-sm">${fmtBig(t.market_cap)}</td>
        <td>${fmtNum(t.pe, 1)}</td>
        <td class="peg">${fmtNum(t.basis)}</td>
        <td>${vs}</td>
        <td class="hide-sm">${buys}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="8" class="na" style="text-align:center;padding:24px">No matches.</td></tr>`;
    renderDetail();
  }

  function renderKpis() {
    const core = D.tickers.filter((t) => t.role === "core");
    const medCore = median(core.map((t) => t[state.basis]));
    const cheapest = D.tickers.filter((t) => t.vs != null && t.role === "core").sort((a, b) => a.vs - b.vs)[0];
    const totalBuys = D.insider_buys.reduce((s, b) => s + (b.value || 0), 0);
    const buyers = new Set(D.insider_buys.map((b) => b.symbol)).size;
    const label = state.basis === "fwd_peg" ? "forward" : "trailing";
    $("#kpis").innerHTML = [
      ["Median " + label + " PEG", medCore != null ? medCore.toFixed(2) : "—", "growth/SaaS names"],
      ["Biggest discount to peers", cheapest ? cheapest.symbol : "—", cheapest ? `${cheapest.vs.toFixed(0)}% vs ${groupName[cheapest.group]} median` : ""],
      ["Insider buying (" + (D.insider_lookback_days || 90) + "d)", fmtBig(totalBuys || null), D.insider_buys.length + " open-market purchases"],
      ["Companies with buys", String(buyers), "of " + D.tickers.length + " tracked"],
    ].map(([l, v, n]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${esc(v)}</div><div class="note">${esc(n)}</div></div>`).join("");
  }

  function renderDetail() {
    const box = $("#detail");
    const t = state.sel && bySym[state.sel];
    if (!t) { box.hidden = true; return; }
    box.hidden = false;
    const label = state.basis === "fwd_peg" ? "Forward PEG" : "Trailing PEG";
    $("#dTitle").textContent = `${t.symbol} · ${t.name}`;
    $("#dSub").textContent = `${label} vs. direct competitors · ${groupName[t.group]}`;
    const set = [t, ...t.competitors.map((s) => bySym[s]).filter(Boolean)];
    const m = medians[t.group];
    const max = Math.max(...set.map((x) => x[state.basis] || 0), m || 0, 1) * 1.1;
    $("#dBars").innerHTML = set.map((x) => {
      const v = x[state.basis];
      const fill = v != null ? `<div class="fill${x === t ? " me" : ""}" style="width:${(v / max) * 100}%"></div>` : "";
      const ref = m ? `<div class="ref" style="left:${(m / max) * 100}%"></div>` : "";
      return `<div class="s">${x.symbol}</div><div class="track">${fill}${ref}</div><div class="v">${v != null ? v.toFixed(2) : '<span class="na">n/a</span>'}</div>`;
    }).join("");

    // What's moving it (AI summary of recent headlines)
    const nw = t.news;
    const mv = $("#dMoves");
    if (!nw) { mv.hidden = true; } else {
      mv.hidden = false;
      $("#dMovesTitle").textContent = `What's moving ${t.symbol} · ${t.name}`;
      const arrow = { up: "▲", down: "▼", neutral: "●" };
      $("#dMovesList").innerHTML = nw.bullets && nw.bullets.length
        ? nw.bullets.map((b) => `<li><span class="arrow ${b.direction}" aria-label="${b.direction}">${arrow[b.direction] || "●"}</span>
            <span>${esc(b.text)} ${b.url ? `<a class="src" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.source || "source")} ↗</a>` : ""}</span></li>`).join("")
        : `<li><span class="arrow neutral">●</span><span>No major news in the past week.</span></li>`;
      $("#dMovesNote").textContent = `AI-generated summary of recent headlines (as of ${fmtDate(nw.as_of)}${nw.stale ? ", not refreshed today" : ""}). May contain errors — check the linked sources.`;
    }

    const buys = buysBySym[t.symbol] || [];
    $("#dBuySub").textContent = buys.length ? `${buys.length} purchase${buys.length > 1 ? "s" : ""} · ${fmtBig(t.buyval)} in the last ${D.insider_lookback_days || 90} days` : `None in the last ${D.insider_lookback_days || 90} days.`;
    $("#dBuys").innerHTML = buys.slice(0, 8).map((b) => `<li><span class="who">${esc(b.insider || "Unknown")}</span>${b.role ? ` <span class="meta">· ${esc(b.role)}</span>` : ""}<br>
      <span class="meta">${fmtDate(b.date)} · ${b.shares != null ? b.shares.toLocaleString() : "—"} sh @ ${fmtMoney(b.price)} = </span><b>${fmtBig(b.value)}</b>
      ${b.url ? ` · <a href="${esc(b.url)}" target="_blank" rel="noopener">filing</a>` : ""}</li>`).join("");
  }

  function renderInsiders() {
    const r = D.insider_buys.slice(0, 100);
    $("#ins tbody").innerHTML = r.length ? r.map((b) => `<tr data-s="${b.symbol}">
      <td><span class="sym">${b.symbol}</span></td>
      <td class="left">${esc(b.insider || "—")}</td>
      <td class="left grp hide-sm">${esc(b.role || "—")}</td>
      <td>${fmtDate(b.date)}</td>
      <td>${b.shares != null ? b.shares.toLocaleString() : "—"}</td>
      <td>${fmtMoney(b.price)}</td>
      <td><b>${fmtBig(b.value)}</b></td>
      <td>${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">SEC ↗</a>` : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="8" class="na" style="text-align:center;padding:24px">No open-market insider purchases in this window.</td></tr>`;
    $("#ins tbody").onclick = (e) => {
      if (e.target.closest("a")) return;
      const tr = e.target.closest("tr[data-s]"); if (!tr) return;
      state.sel = tr.dataset.s; state.group = "all"; state.q = ""; $("#q").value = "";
      [...$("#chips").children].forEach((c) => c.classList.toggle("on", c.dataset.g === "all"));
      render(); $("#detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
  }
})();
