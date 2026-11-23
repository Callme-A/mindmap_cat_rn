
(function () {
  "use strict";

  const data = window.CATRN_DATA;
  const $ = id => document.getElementById(id);

  if (!data) {
    $("status").textContent =
      "Ошибка: data.js не загружен. Проверьте имя и путь к файлу.";
    $("status").parentElement.classList.add("error");
    return;
  }

  const NS = "http://www.w3.org/2000/svg";
  const svg = $("mapSvg");
  const canvas = $("canvas");
  const viewport = $("viewport");
  const linksLayer = $("links");
  const nodesLayer = $("nodes");

  const nodes = data.nodes.map(node => ({ ...node }));
  const byId = new Map(nodes.map(node => [node.id, node]));

  const sizes = {
    root: [310, 112],
    stage: [264, 94],
    issue: [260, 96],
    stop: [280, 94]
  };

  const STORE_KEY = "catrn-mindmap-v4";

  let camera = { x: 0, y: 0, scale: 0.85 };
  let selectedId = null;
  let collapsed = new Set();
  let notes = {};
  let drag = null;
  let pinch = null;
  const pointers = new Map();

  // Восстановление пользовательских изменений.
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");

    if (saved) {
      (saved.positions || []).forEach(item => {
        const node = byId.get(item.id);
        if (node && Number.isFinite(item.x) &&
            Number.isFinite(item.y)) {
          node.x = item.x;
          node.y = item.y;
        }
      });

      collapsed = new Set(saved.collapsed || []);
      notes = saved.notes || {};
    }
  } catch (error) {
    console.warn("Локальное хранилище недоступно:", error);
  }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        positions: nodes.map(n => ({ id: n.id, x: n.x, y: n.y })),
        collapsed: [...collapsed],
        notes
      }));
    } catch (error) {
      console.warn("Не удалось сохранить состояние:", error);
    }
  }

  function createSVG(tag, attrs = {}, content) {
    const element = document.createElementNS(NS, tag);

    Object.entries(attrs).forEach(([key, value]) => {
      element.setAttribute(key, String(value));
    });

    if (content !== undefined) element.textContent = content;
    return element;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function nodeSize(node) {
    return sizes[node.type];
  }

  function isVisible(node) {
    return node.type !== "issue" || !collapsed.has(node.parent);
  }

  function wrapText(value, limit, maxLines = 2) {
    const words = String(value).split(/\s+/);
    const result = [];
    let line = "";

    words.forEach(word => {
      const proposed = line ? line + " " + word : word;

      if (proposed.length > limit && line) {
        result.push(line);
        line = word;
      } else {
        line = proposed;
      }
    });

    if (line) result.push(line);

    if (result.length > maxLines) {
      const remaining = result.slice(maxLines - 1).join(" ");
      result.length = maxLines;
      result[maxLines - 1] =
        remaining.length > limit
          ? remaining.slice(0, limit - 1) + "…"
          : remaining;
    }

    return result;
  }

  function drawConnection(parent, child) {
    if (!parent || !child || !isVisible(child)) return;

    const [pw, ph] = nodeSize(parent);
    const [cw, ch] = nodeSize(child);

    const special = child.type === "stop";
    let d;

    if (special) {
      const y1 = parent.y + ph / 2;
      const y2 = child.y - ch / 2;
      const middle = (y1 + y2) / 2;

      d = `M ${parent.x} ${y1}
           C ${parent.x} ${middle},
             ${child.x} ${middle},
             ${child.x} ${y2}`;
    } else {
      const direction = child.x >= parent.x ? 1 : -1;
      const x1 = parent.x + direction * pw / 2;
      const x2 = child.x - direction * cw / 2;
      const middle = (x1 + x2) / 2;

      d = `M ${x1} ${parent.y}
           C ${middle} ${parent.y},
             ${middle} ${child.y},
             ${x2} ${child.y}`;
    }

    const color = special
      ? "#c28d4c"
      : child.type === "stage"
        ? child.color
        : parent.color || "#347aa5";

    // Белая подложка делает связь видимой на сетке.
    linksLayer.appendChild(createSVG("path", {
      d,
      fill: "none",
      stroke: "#ffffff",
      "stroke-width": child.type === "stage" ? 10 : 8,
      "stroke-linecap": "round"
    }));

    linksLayer.appendChild(createSVG("path", {
      d,
      fill: "none",
      stroke: color,
      "stroke-width": child.type === "stage" ? 5 : 3.5,
      "stroke-linecap": "round",
      "stroke-dasharray": special ? "9 6" : "none"
    }));
  }

  function drawLinks() {
    linksLayer.replaceChildren();

    // Все соединения строятся из родительских ID.
    nodes.forEach(node => {
      if (!node.parent || !isVisible(node)) return;

      drawConnection(byId.get(node.parent), node);
    });
  }

  function addText(group, text, x, y, options = {}) {
    const element = createSVG("text", {
      x,
      y,
      fill: options.fill || "#20313e",
      "font-size": options.size || 14,
      "font-weight": options.weight || 500,
      "font-family": "Arial, Helvetica, sans-serif",
      "text-anchor": options.anchor || "start",
      "pointer-events": "none"
    }, text);

    group.appendChild(element);
  }

  function drawNode(node) {
    const [width, height] = nodeSize(node);
    const root = node.type === "root";
    const stage = node.type === "stage";
    const stop = node.type === "stop";

    const group = createSVG("g", {
      transform: `translate(${node.x} ${node.y})`,
      "data-node": node.id,
      tabindex: "0",
      role: "button",
      "aria-label": node.title
    });

    const background = root ? "#003152"
      : stage ? "#e3eff7"
      : stop ? "#fff2df"
      : "#ffffff";

    const border = root ? "#003152"
      : stage ? node.color
      : stop ? "#bb884a"
      : "#9abbd1";

    group.appendChild(createSVG("rect", {
      x: -width / 2,
      y: -height / 2,
      width,
      height,
      rx: 12,
      fill: background,
      stroke: border,
      "stroke-width": selectedId === node.id ? 4 : 2
    }));

    if (selectedId === node.id) {
      group.appendChild(createSVG("rect", {
        x: -width / 2 - 5,
        y: -height / 2 - 5,
        width: width + 10,
        height: height + 10,
        rx: 16,
        fill: "none",
        stroke: "#2587c2",
        "stroke-width": 2,
        "stroke-dasharray": "5 4"
      }));
    }

    const textColor = root ? "#ffffff" : "#19364c";
    const secondary = root ? "#c3dfef" : "#566f80";
    const x = root ? 0 : -width / 2 + 16;
    const anchor = root ? "middle" : "start";

    let kicker = "ДИАГНОСТИЧЕСКИЙ СЦЕНАРИЙ";

    if (root) kicker = "B2B / ЦАТ РН";
    if (stage) kicker = "ЭТАП " + node.number;
    if (stop) kicker = "НЕКОММУНИКАЦИОННЫЙ БАРЬЕР";

    addText(
      group, kicker,
      x, -height / 2 + 19,
      {
        size: 10,
        weight: 800,
        fill: secondary,
        anchor
      }
    );

    const lines = wrapText(
      node.title,
      root ? 24 : stage ? 27 : 28,
      2
    );

    const firstY = lines.length === 2 ? -9 : 2;

    lines.forEach((line, index) => {
      addText(
        group,
        line,
        x,
        firstY + index * 20,
        {
          size: root ? 20 : stage ? 16 : 14,
          weight: 750,
          fill: textColor,
          anchor
        }
      );
    });

    const maxSub = root ? 44 : 35;
    const subtitle = node.subtitle.length > maxSub
      ? node.subtitle.slice(0, maxSub - 1) + "…"
      : node.subtitle;

    addText(
      group,
      subtitle,
      x,
      height / 2 - 12,
      {
        size: 10.5,
        fill: secondary,
        anchor
      }
    );

    // У стадий есть независимая кнопка сворачивания.
    if (stage) {
      const toggle = createSVG("g", {
        "data-toggle": node.id,
        role: "button",
        "aria-label": collapsed.has(node.id)
          ? "Развернуть ветвь"
          : "Свернуть ветвь"
      });

      toggle.appendChild(createSVG("circle", {
        cx: width / 2 - 19,
        cy: 0,
        r: 15,
        fill: "#ffffff",
        stroke: node.color,
        "stroke-width": 1.5
      }));

      addText(
        toggle,
        collapsed.has(node.id) ? "+" : "−",
        width / 2 - 19,
        6,
        {
          size: 20,
          weight: 750,
          fill: node.color,
          anchor: "middle"
        }
      );

      group.appendChild(toggle);
    }

    return group;
  }

  function drawNodes() {
    nodesLayer.replaceChildren();

    nodes.filter(isVisible).forEach(node => {
      nodesLayer.appendChild(drawNode(node));
    });

    highlightSearch();
  }

  function draw() {
    drawLinks();
    drawNodes();
  }

  function resize() {
    const width = Math.max(1, svg.clientWidth);
    const height = Math.max(1, svg.clientHeight);

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    updateCamera();
  }

  function updateCamera() {
    viewport.setAttribute(
      "transform",
      `translate(${camera.x} ${camera.y}) scale(${camera.scale})`
    );

    $("zoomValue").textContent =
      Math.round(camera.scale * 100) + "%";

    canvas.style.backgroundSize =
      23 * camera.scale + "px " +
      23 * camera.scale + "px";

    canvas.style.backgroundPosition =
      camera.x + "px " + camera.y + "px";
  }

  function centerMap() {
    camera.scale = svg.clientWidth < 600 ? 0.8 : 0.9;
    camera.x = svg.clientWidth / 2;
    camera.y = svg.clientHeight / 2;

    updateCamera();
  }

  function fitMap() {
    const visible = nodes.filter(isVisible);

    const left = Math.min(
      ...visible.map(n => n.x - nodeSize(n)[0] / 2)
    );
    const right = Math.max(
      ...visible.map(n => n.x + nodeSize(n)[0] / 2)
    );
    const top = Math.min(
      ...visible.map(n => n.y - nodeSize(n)[1] / 2)
    );
    const bottom = Math.max(
      ...visible.map(n => n.y + nodeSize(n)[1] / 2)
    );

    camera.scale = clamp(
      Math.min(
        (svg.clientWidth - 48) / (right - left),
        (svg.clientHeight - 48) / (bottom - top),
        1.2
      ),
      0.12,
      1.2
    );

    camera.x =
      svg.clientWidth / 2 -
      (left + right) / 2 * camera.scale;

    camera.y =
      svg.clientHeight / 2 -
      (top + bottom) / 2 * camera.scale;

    updateCamera();
  }

  function zoomAt(nextScale, x, y) {
    const scale = clamp(nextScale, 0.12, 2.5);

    const worldX = (x - camera.x) / camera.scale;
    const worldY = (y - camera.y) / camera.scale;

    camera.scale = scale;
    camera.x = x - worldX * scale;
    camera.y = y - worldY * scale;

    updateCamera();
  }

  function focusNode(node) {
    camera.x = svg.clientWidth / 2 - node.x * camera.scale;
    camera.y = svg.clientHeight / 2 - node.y * camera.scale;
    updateCamera();
  }

  function section(title, content) {
    return `<section>
      <h3>${escapeHTML(title)}</h3>
      ${content}
    </section>`;
  }

  function list(items) {
    return "<ul>" + items.map(item =>
      `<li>${escapeHTML(item)}</li>`
    ).join("") + "</ul>";
  }

  function showDetails(node) {
    const content = $("detailContent");
    let html = "";

    $("detailTitle").textContent = node.title;
    $("detailDescription").textContent = node.subtitle;

    if (node.type === "root") {
      $("detailType").textContent = "Концепция проекта";

      html += section(
        "Задача",
        "<p>Выявить информационный барьер в конкретном взаимодействии с предприятием и подобрать подходящий коммуникационный инструмент.</p>"
      );

      html += section(
        "Основание",
        `<div class="evidence">
          В брифе названы высокая стоимость SLM, недостаточное
          понимание технологии и сложности закупок.
          Данных о реальной конверсии и причинах отказов нет.
        </div>`
      );

      html += section(
        "Что представляет команда",
        "<p>Сценарную модель, диагностическую карточку, структуру коммуникационных материалов, регламент внедрения и систему оценки.</p>"
      );

      html += section(
        "Пилот для ЦАТ",
        list(data.pilot.steps)
      );

      html += section(
        "Участники",
        list(data.pilot.roles)
      );

      html += section(
        "KPI",
        list(data.pilot.metrics)
      );

      html += section(
        "Расчётный бюджет",
        `<p>Предварительная оценка стоимости трудозатрат.
        Это не подтверждённые рыночные ставки.</p>
        <div class="budget-grid">
          <label>
            Часы: <span id="hoursValue">48</span>
            <input id="hoursSlider" type="range"
                   min="36" max="60" value="48">
          </label>
          <label>
            Ставка: <span id="rateValue">55</span> BYN/час
            <input id="rateSlider" type="range"
                   min="40" max="70" value="55">
          </label>
        </div>
        <div class="budget-result" id="budgetResult"></div>
        <p>С резервом 10%. Не включены испытания,
        изготовление образцов, командировки и платное продвижение.</p>`
      );
    }

    if (node.type === "stage") {
      $("detailType").textContent =
        "Этап взаимодействия " + node.number;

      const stage = data.stages.find(s => s.id === node.id);

      html += section(
        "Возможные барьеры",
        list(stage.children.map(item =>
          data.barriers[item.key].title
        ))
      );

      html += section(
        "Как проводить диагностику",
        "<p>Менеджер фиксирует вопрос заказчика, определяет недостающую информацию и уточняет, кто должен принять следующее решение. Затем выбирается инструмент, а технические аргументы проверяются инженером ЦАТ.</p>"
      );

      html += section(
        "Важно",
        '<div class="warning">Наличие этой стадии не означает, что ЦАТ действительно теряет на ней заказы. Это сценарий для проверки.</div>'
      );
    }

    if (node.type === "issue") {
      const barrier = data.barriers[node.barrier];

      $("detailType").textContent = barrier.status;
      $("detailTitle").textContent = barrier.title;

      html += section(
        "Основание",
        `<div class="evidence">${escapeHTML(barrier.basis)}</div>`
      );

      html += section(
        "Диагностические признаки",
        list(barrier.signals)
      );

      html += section(
        "Вопросы менеджера",
        list(barrier.questions)
      );

      html += section(
        "Коммуникационный инструмент",
        `<p><strong>${escapeHTML(barrier.instrument)}</strong></p>
         <p>${escapeHTML(barrier.content)}</p>`
      );

      html += section(
        "Кому направляем",
        `<p>${escapeHTML(barrier.audience)}</p>`
      );

      html += section(
        "Каналы взаимодействия",
        `<p>${escapeHTML(barrier.channels)}</p>`
      );

      html += section(
        "Ответственные",
        `<p>${escapeHTML(barrier.responsible)}</p>`
      );

      html += section(
        "Результат и KPI",
        `<p>${escapeHTML(barrier.kpi)}</p>`
      );

      html += section(
        "Ограничение",
        `<div class="warning">${escapeHTML(barrier.limitation)}</div>`
      );
    }

    if (node.type === "stop") {
      $("detailType").textContent =
        "Причины вне сферы коммуникаций";

      html += section(
        "Примеры",
        list([
          "SLM не обеспечивает обязательные свойства изделия.",
          "Отсутствует необходимая сертификация или допуск.",
          "Традиционная технология объективно выгоднее.",
          "У предприятия отсутствует потребность или финансирование."
        ])
      );

      html += section(
        "Решение",
        `<div class="warning">
          Не применять рекламное убеждение вместо инженерного,
          экономического или нормативного решения.
          Передать вопрос профильному специалисту либо
          корректно завершить переговоры.
        </div>`
      );
    }

    html += section(
      "Рабочая заметка",
      `<textarea class="note" id="noteArea"
       placeholder="Замечания к сценарию…"></textarea>
       <div class="note-caption">
         Сохраняется в браузере на этом устройстве.
       </div>`
    );

    content.innerHTML = html;
    $("details").hidden = false;
    $("main").classList.add("has-details");

    const noteArea = $("noteArea");
    noteArea.value = notes[node.id] || "";

    noteArea.addEventListener("input", () => {
      notes[node.id] = noteArea.value;
      saveState();
    });

    const hours = $("hoursSlider");
    const rate = $("rateSlider");

    if (hours && rate) {
      const calculate = () => {
        const h = Number(hours.value);
        const r = Number(rate.value);

        $("hoursValue").textContent = h;
        $("rateValue").textContent = r;

        $("budgetResult").textContent =
          new Intl.NumberFormat("ru-RU", {
            maximumFractionDigits: 0
          }).format(h * r * 1.1) + " BYN";
      };

      hours.addEventListener("input", calculate);
      rate.addEventListener("input", calculate);
      calculate();
    }

    resize();
  }

  function selectNode(id) {
    const node = byId.get(id);
    if (!node) return;

    selectedId = id;
    draw();
    showDetails(node);
  }

  function closeDetails() {
    $("details").hidden = true;
    $("main").classList.remove("has-details");
    selectedId = null;
    draw();
    resize();
  }

  function toggleStage(id) {
    if (collapsed.has(id)) {
      collapsed.delete(id);
    } else {
      collapsed.add(id);
    }

    draw();
    saveState();
  }

  function screenPoint(event) {
    const rect = svg.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function startPinch() {
    if (pointers.size < 2) return;

    const points = [...pointers.values()];
    const x = (points[0].x + points[1].x) / 2;
    const y = (points[0].y + points[1].y) / 2;

    pinch = {
      distance: Math.hypot(
        points[0].x - points[1].x,
        points[0].y - points[1].y
      ) || 1,
      scale: camera.scale,
      worldX: (x - camera.x) / camera.scale,
      worldY: (y - camera.y) / camera.scale
    };

    drag = null;
  }

  svg.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const toggle = event.target.closest("[data-toggle]");

    if (toggle) {
      toggleStage(toggle.getAttribute("data-toggle"));
      event.preventDefault();
      return;
    }

    const point = screenPoint(event);
    pointers.set(event.pointerId, point);

    try {
      svg.setPointerCapture(event.pointerId);
    } catch (error) {}

    if (pointers.size >= 2) {
      startPinch();
      return;
    }

    const element = event.target.closest("[data-node]");
    const node = element
      ? byId.get(element.getAttribute("data-node"))
      : null;

    drag = {
      type: node ? "node" : "pan",
      id: node ? node.id : null,
      startX: point.x,
      startY: point.y,
      camX: camera.x,
      camY: camera.y,
      nodeX: node ? node.x : 0,
      nodeY: node ? node.y : 0,
      moved: false
    };

    canvas.classList.add("dragging");
    event.preventDefault();
  });

  svg.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId)) return;

    const point = screenPoint(event);
    pointers.set(event.pointerId, point);

    if (pointers.size >= 2) {
      if (!pinch) startPinch();

      const points = [...pointers.values()];

      const distance = Math.hypot(
        points[0].x - points[1].x,
        points[0].y - points[1].y
      ) || 1;

      const x = (points[0].x + points[1].x) / 2;
      const y = (points[0].y + points[1].y) / 2;

      camera.scale = clamp(
        pinch.scale * distance / pinch.distance,
        0.12,
        2.5
      );

      camera.x = x - pinch.worldX * camera.scale;
      camera.y = y - pinch.worldY * camera.scale;

      updateCamera();
      return;
    }

    if (!drag) return;

    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;

    if (Math.hypot(dx, dy) > 5) drag.moved = true;

    if (drag.type === "pan") {
      camera.x = drag.camX + dx;
      camera.y = drag.camY + dy;
      updateCamera();
    } else {
      const node = byId.get(drag.id);

      node.x = drag.nodeX + dx / camera.scale;
      node.y = drag.nodeY + dy / camera.scale;

      // Обновляются и узлы, и связанные с ними линии.
      draw();
    }
  });

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;

    pointers.delete(event.pointerId);

    if (pointers.size === 0) {
      if (drag && drag.type === "node" && !drag.moved) {
        selectNode(drag.id);
      }

      drag = null;
      pinch = null;

      canvas.classList.remove("dragging");
      saveState();
    } else if (pointers.size === 1) {
      pinch = null;

      const point = [...pointers.values()][0];

      drag = {
        type: "pan",
        startX: point.x,
        startY: point.y,
        camX: camera.x,
        camY: camera.y,
        moved: false
      };
    }
  }

  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  svg.addEventListener("wheel", event => {
    event.preventDefault();

    const point = screenPoint(event);
    const next = camera.scale * Math.exp(-event.deltaY * 0.0014);

    zoomAt(next, point.x, point.y);
  }, { passive: false });

  svg.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;

    const element = event.target.closest("[data-node]");
    if (!element) return;

    event.preventDefault();
    selectNode(element.getAttribute("data-node"));
  });

  function highlightSearch() {
    const term = $("search").value.trim().toLowerCase();

    nodesLayer.querySelectorAll("[data-node]").forEach(group => {
      const node = byId.get(group.getAttribute("data-node"));

      const extra = node.barrier
        ? data.barriers[node.barrier].title + " " +
          data.barriers[node.barrier].instrument
        : "";

      const text = (
        node.title + " " + node.subtitle + " " + extra
      ).toLowerCase();

      group.setAttribute(
        "opacity",
        !term || node.type === "root" || text.includes(term)
          ? "1"
          : "0.2"
      );
    });
  }

  $("search").addEventListener("input", highlightSearch);

  $("search").addEventListener("keydown", event => {
    if (event.key !== "Enter") return;

    const term = $("search").value.trim().toLowerCase();

    const found = nodes.find(node =>
      isVisible(node) &&
      (node.title + " " + node.subtitle +
       (node.barrier ? " " + data.barriers[node.barrier].title : "")
      ).toLowerCase().includes(term)
    );

    if (found) {
      selectNode(found.id);
      focusNode(found);
      $("search").blur();
    }
  });

  $("fitBtn").addEventListener("click", fitMap);
  $("centerBtn").addEventListener("click", centerMap);

  $("zoomIn").addEventListener("click", () => {
    zoomAt(
      camera.scale * 1.2,
      svg.clientWidth / 2,
      svg.clientHeight / 2
    );
  });

  $("zoomOut").addEventListener("click", () => {
    zoomAt(
      camera.scale / 1.2,
      svg.clientWidth / 2,
      svg.clientHeight / 2
    );
  });

  $("expandBtn").addEventListener("click", () => {
    collapsed.clear();
    draw();
    saveState();
  });

  $("collapseBtn").addEventListener("click", () => {
    collapsed = new Set(data.stages.map(stage => stage.id));
    draw();
    saveState();
  });

  $("resetBtn").addEventListener("click", () => {
    if (!confirm("Вернуть исходное расположение узлов?")) return;

    data.nodes.forEach(original => {
      const node = byId.get(original.id);
      node.x = original.x;
      node.y = original.y;
    });

    collapsed.clear();
    draw();
    centerMap();
    saveState();
  });

  $("closeDetails").addEventListener("click", closeDetails);

  $("copyBtn").addEventListener("click", async () => {
    const text =
      $("detailTitle").textContent + "\n\n" +
      $("detailContent").innerText;

    try {
      await navigator.clipboard.writeText(text);
      $("status").textContent = "Описание скопировано.";
    } catch (error) {
      downloadFile("ЦАТ_описание.txt", text, "text/plain");
    }
  });

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], {
      type: mime + ";charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportState() {
    return {
      version: data.version,
      project: "От техаудита к SLM-заказу",
      positions: nodes.map(node => ({
        id: node.id, x: node.x, y: node.y
      })),
      collapsed: [...collapsed],
      notes
    };
  }

  $("exportBtn").addEventListener("click", () => {
    downloadFile(
      "ЦАТ_майндкарта_состояние.json",
      JSON.stringify(exportState(), null, 2),
      "application/json"
    );
  });

  $("importBtn").addEventListener("click", () => {
    $("importFile").click();
  });

  $("importFile").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const saved = JSON.parse(await file.text());

      if (!Array.isArray(saved.positions)) {
        throw new Error("В файле нет данных расположения узлов.");
      }

      saved.positions.forEach(item => {
        const node = byId.get(item.id);

        if (node && Number.isFinite(item.x) &&
            Number.isFinite(item.y)) {
          node.x = item.x;
          node.y = item.y;
        }
      });

      collapsed = new Set(
        (saved.collapsed || []).filter(id =>
          data.stages.some(stage => stage.id === id)
        )
      );

      notes = saved.notes && typeof saved.notes === "object"
        ? saved.notes
        : {};

      draw();
      fitMap();
      saveState();

      $("status").textContent = "Сохранённая карта импортирована.";
    } catch (error) {
      alert("Ошибка импорта: " + error.message);
    }

    event.target.value = "";
  });

  $("fullscreenBtn").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await $("app").requestFullscreen();
      }
    } catch (error) {
      $("status").textContent =
        "Браузер ограничивает полноэкранный режим.";
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("details").hidden) {
      closeDetails();
    }
  });

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
  } else {
    window.addEventListener("resize", resize);
  }

  // Запуск приложения.
  draw();
  resize();
  centerMap();

  $("status").textContent =
    "Карта загружена. " + nodes.length +
    " узлов, " + data.stages.length +
    " стадий. Все основные функции работают локально.";

})();
