import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Layers, Plus, ChevronLeft, Edit2, Trash2, Link2, X, Check,
  Play, RotateCcw, Search, GitBranch, BookOpen, Hash, Clock, Zap,
  FileText, CheckCircle, XCircle, Award, ArrowRight, List, ToggleLeft, AlignLeft,
  Flame, Target, Trophy, Star, Medal, Sparkles, Bell, Lock, TrendingUp
} from "lucide-react";

// icon lookup for data-driven badges/toasts
const ICONS = { Flame, Target, Trophy, Star, Medal, Sparkles, Award, Layers, FileText, BookOpen };
const Icon = ({ name, ...p }) => {
  const C = ICONS[name] || Star;
  return <C {...p} />;
};

/* ============================================================
   ZettelCards — flashcards (Anki-style SRS) + Zettelkasten links
   Single-file React artifact. Persistence via localStorage.
   ============================================================ */

// ---------- Spaced-repetition (SM-2, adapted to 4 grades) ----------
const GRADES = {
  again: { label: "Muy difícil", q: 0, hint: "No la recordé", accent: "#b4413c" },
  hard:  { label: "Difícil",     q: 3, hint: "Con esfuerzo",   accent: "#c08a2e" },
  good:  { label: "Medio",       q: 4, hint: "La recordé",     accent: "#4a6f8a" },
  easy:  { label: "Fácil",       q: 5, hint: "Sin dudar",      accent: "#4f7a52" },
};
const DAY = 86400000;

function schedule(card, key) {
  const g = GRADES[key].q;
  let { interval = 0, repetition = 0, ease = 2.5 } = card.srs || {};
  if (g < 3) {
    repetition = 0;
    interval = key === "again" ? 0 : 1; // again -> back in same session
  } else {
    repetition += 1;
    if (repetition === 1) interval = 1;
    else if (repetition === 2) interval = key === "easy" ? 4 : 3;
    else interval = Math.round(interval * ease);
    ease = Math.max(1.3, ease + (0.1 - (5 - g) * (0.08 + (5 - g) * 0.02)));
    if (key === "hard") interval = Math.max(1, Math.round(interval * 0.8));
  }
  const due = Date.now() + interval * DAY;
  return { interval, repetition, ease, due, lastGrade: key };
}
const isDue = (c) => !c.srs?.due || c.srs.due <= Date.now();

// ---------- storage helpers ----------
const KEY = "zettelcards:state:v1";
async function loadState() {
  try {
    const r = await localStorage.getItem(KEY);
    return r ? JSON.parse(r) : null;
  } catch { return null; }
}
async function saveState(state) {
  try { await localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
}

const uid = () => Math.random().toString(36).slice(2, 9);

// ---------- gamification ----------
// Day key in local time, e.g. "2026-06-25"
const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const daysBetween = (a, b) => {
  const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]), db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((db - da) / DAY);
};

const freshGame = () => ({
  xp: 0,
  streak: 0,
  best: 0,
  lastDay: null,      // last day the daily goal was met
  today: dayKey(),
  todayCount: 0,      // reviews + exam answers logged today
  goal: 10,           // daily target (cards)
  freezes: 1,         // streak protectors; absorb a missed day automatically
  goalDays: 0,        // total days the goal was met (for achievements)
  totalReviews: 0,
  totalExams: 0,
  bestExam: 0,        // best exam percentage
  unlocked: {},       // achievementId -> dayKey unlocked
});

// Achievement catalog. `check(g)` returns true when earned.
const ACHIEVEMENTS = [
  { id: "first",     icon: "Sparkles", name: "Primer paso",     desc: "Repasa tu primera nota.",         check: (g) => g.totalReviews >= 1 },
  { id: "goal1",     icon: "Target",   name: "Meta cumplida",   desc: "Alcanza tu meta diaria una vez.", check: (g) => g.goalDays >= 1 },
  { id: "streak3",   icon: "Flame",    name: "En marcha",       desc: "Racha de 3 días.",                check: (g) => g.best >= 3 },
  { id: "streak7",   icon: "Flame",    name: "Semana perfecta", desc: "Racha de 7 días.",                check: (g) => g.best >= 7 },
  { id: "streak30",  icon: "Trophy",   name: "Constancia",      desc: "Racha de 30 días.",               check: (g) => g.best >= 30 },
  { id: "reviews50", icon: "Layers",   name: "Cincuentena",     desc: "50 repasos en total.",            check: (g) => g.totalReviews >= 50 },
  { id: "reviews250",icon: "Award",    name: "Veterano",        desc: "250 repasos en total.",           check: (g) => g.totalReviews >= 250 },
  { id: "exam1",     icon: "FileText", name: "Primera prueba",  desc: "Completa un examen.",             check: (g) => g.totalExams >= 1 },
  { id: "exam100",   icon: "Medal",    name: "Sin fallos",      desc: "Saca 100% en un examen.",         check: (g) => g.bestExam >= 100 },
  { id: "goal10",    icon: "Star",     name: "Disciplina",      desc: "Cumple la meta 10 días.",         check: (g) => g.goalDays >= 10 },
];

const LEVEL_STEP = 100; // xp per level
const levelOf = (xp) => Math.floor(xp / LEVEL_STEP) + 1;
const levelProgress = (xp) => (xp % LEVEL_STEP) / LEVEL_STEP;

// Roll the day forward, applying freeze protection so a lapse rarely resets progress.
// Mutates and returns the game object. Call before logging today's activity.
function rollStreak(g) {
  const today = dayKey();
  if (g.today === today) return g; // already current
  if (!g.lastDay) { g.today = today; g.todayCount = 0; return g; }
  const gap = daysBetween(g.lastDay, today);
  if (gap > 1) {
    const missed = gap - 1; // full days skipped
    if (g.freezes >= missed) {
      g.freezes -= missed; // protected, streak survives
    } else {
      g.freezes = 0;
      g.streak = 0; // lapse too long even for protection
    }
  }
  g.today = today;
  g.todayCount = 0;
  return g;
}

// Log study activity (n cards). Returns { newAchievements:[], goalJustMet, leveledTo|null }.
function logActivity(g, n, opts = {}) {
  rollStreak(g);
  const beforeGoalMet = g.todayCount >= g.goal;
  const beforeLevel = levelOf(g.xp);
  g.todayCount += n;
  if (!opts.exam) g.totalReviews += n;
  g.xp += n * (opts.exam ? 2 : 3);
  if (opts.examDone) {
    g.totalExams += 1;
    if (opts.examPct != null) g.bestExam = Math.max(g.bestExam, opts.examPct);
  }

  let goalJustMet = false;
  if (g.todayCount >= g.goal && !beforeGoalMet) {
    goalJustMet = true;
    g.goalDays += 1;
    if (g.lastDay !== g.today) {
      const gap = g.lastDay ? daysBetween(g.lastDay, g.today) : 1;
      g.streak = gap === 1 || !g.lastDay ? g.streak + 1 : 1;
      g.lastDay = g.today;
      g.best = Math.max(g.best, g.streak);
      if (g.streak % 5 === 0) g.freezes = Math.min(3, g.freezes + 1); // earn protection
    }
  }

  const newAchievements = [];
  ACHIEVEMENTS.forEach((a) => {
    if (!g.unlocked[a.id] && a.check(g)) {
      g.unlocked[a.id] = dayKey();
      newAchievements.push(a);
    }
  });

  const leveledTo = levelOf(g.xp) > beforeLevel ? levelOf(g.xp) : null;
  return { newAchievements, goalJustMet, leveledTo };
}

const seed = () => {
  const d1 = uid(), d2 = uid();
  const c = (deck, front, back, tags = []) => ({
    id: uid(), deck, front, back, tags, links: [],
    srs: null, created: Date.now(),
  });
  const cards = [
    c(d1, "¿Qué es un Zettelkasten?", "Un sistema de notas atómicas e interconectadas donde el valor surge de los enlaces entre ideas, no de las notas aisladas.", ["método"]),
    c(d1, "Principio de atomicidad", "Cada nota contiene una sola idea, de modo que pueda enlazarse y reutilizarse en muchos contextos distintos.", ["método"]),
    c(d2, "Algoritmo SM-2", "Calcula el próximo intervalo de repaso a partir de la calidad de la respuesta y un factor de facilidad que se ajusta con el tiempo.", ["srs"]),
    c(d2, "Repetición espaciada", "Técnica que programa los repasos justo antes del olvido previsto, alargando el intervalo cuando la respuesta es buena.", ["srs"]),
  ];
  // sample links
  cards[0].links = [cards[1].id];
  cards[1].links = [cards[0].id, cards[3].id];
  cards[3].links = [cards[2].id];
  return {
    decks: [
      { id: d1, name: "Zettelkasten", desc: "Fundamentos del método de notas" },
      { id: d2, name: "Memoria y repaso", desc: "Cómo retener a largo plazo" },
    ],
    cards,
    game: freshGame(),
  };
};

// ---------- root ----------
export default function App() {
  const [state, setState] = useState(null);
  const [view, setView] = useState({ name: "decks" });
  const [loaded, setLoaded] = useState(false);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    (async () => {
      const s = await loadState();
      const next = s || seed();
      if (!next.game) next.game = freshGame();        // migrate older saves
      rollStreak(next.game);                          // apply freezes / day rollover
      setState(next);
      setLoaded(true);
    })();
  }, []);
  useEffect(() => { if (loaded && state) saveState(state); }, [state, loaded]);

  const update = useCallback((fn) => setState((s) => fn(structuredClone(s))), []);

  const pushToast = useCallback((t) => {
    const id = uid();
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.long ? 5200 : 3600);
  }, []);

  // Central reward hook: records activity and surfaces celebrations.
  const logStudy = useCallback((n, opts = {}) => {
    setState((s) => {
      const next = structuredClone(s);
      const res = logActivity(next.game, n, opts);
      if (res.goalJustMet) pushToast({ kind: "goal", title: "Meta diaria cumplida", body: `Racha de ${next.game.streak} día${next.game.streak === 1 ? "" : "s"}`, long: true });
      if (res.leveledTo) pushToast({ kind: "level", title: `Nivel ${res.leveledTo}`, body: "Sigues subiendo" });
      res.newAchievements.forEach((a) => pushToast({ kind: "ach", title: "Logro desbloqueado", body: a.name, icon: a.icon, long: true }));
      return next;
    });
  }, [pushToast]);

  if (!loaded) {
    return (
      <div style={{ ...S.app, display: "grid", placeItems: "center" }}>
        <div style={{ color: C.faint, fontFamily: F.ui, fontSize: 14, letterSpacing: ".08em" }}>
          cargando…
        </div>
      </div>
    );
  }

  return (
    <div style={S.app}>
      <Styles />
      <Header view={view} setView={setView} game={state.game} />
      <main style={S.main}>
        {view.name === "decks" && (
          <DeckList state={state} update={update} setView={setView} />
        )}
        {view.name === "deck" && (
          <DeckDetail state={state} update={update} setView={setView} deckId={view.deckId} />
        )}
        {view.name === "study" && (
          <Study state={state} update={update} setView={setView} deckId={view.deckId} logStudy={logStudy} />
        )}
        {view.name === "graph" && (
          <Graph state={state} setView={setView} />
        )}
        {view.name === "examSetup" && (
          <ExamSetup state={state} setView={setView} deckId={view.deckId} />
        )}
        {view.name === "exam" && (
          <Exam state={state} setView={setView} config={view.config} logStudy={logStudy} />
        )}
        {view.name === "progress" && (
          <Progress state={state} update={update} setView={setView} pushToast={pushToast} />
        )}
      </main>
      <ToastStack toasts={toasts} />
    </div>
  );
}

// ---------- header ----------
function Header({ view, setView, game }) {
  const g = game || freshGame();
  const goalMet = g.todayCount >= g.goal;
  return (
    <header style={S.header}>
      <button style={S.brand} onClick={() => setView({ name: "decks" })}>
        <span style={S.brandMark}><Layers size={17} strokeWidth={2} /></span>
        <span style={S.brandText}>
          Zettel<span style={{ color: C.accent }}>Cards</span>
        </span>
      </button>
      <nav style={S.nav}>
        <button className="streakchip" style={S.streakChip} onClick={() => setView({ name: "progress" })}
          title={`Racha de ${g.streak} días · ${g.todayCount}/${g.goal} hoy`}>
          <Flame size={15} strokeWidth={2.4} color={g.streak > 0 ? C.flame : C.faint}
            fill={g.streak > 0 ? C.flame : "none"} />
          <span style={{ ...S.streakNum, color: g.streak > 0 ? C.flame : C.faint }}>{g.streak}</span>
          <span style={S.streakDivider} />
          <span style={{ ...S.streakGoal, color: goalMet ? C.success : C.sub }}>
            {goalMet ? <Check size={13} strokeWidth={3} /> : `${g.todayCount}/${g.goal}`}
          </span>
        </button>
        <NavBtn active={view.name === "decks"} onClick={() => setView({ name: "decks" })} icon={BookOpen}>
          Mazos
        </NavBtn>
        <NavBtn active={view.name === "graph"} onClick={() => setView({ name: "graph" })} icon={GitBranch}>
          Constelación
        </NavBtn>
        <NavBtn active={view.name === "progress"} onClick={() => setView({ name: "progress" })} icon={Trophy}>
          Progreso
        </NavBtn>
      </nav>
    </header>
  );
}
function NavBtn({ active, onClick, icon: IconC, children }) {
  return (
    <button onClick={onClick} className="navbtn" style={{ ...S.navBtn, ...(active ? S.navBtnActive : {}) }}>
      <IconC size={15} strokeWidth={2} />
      <span>{children}</span>
    </button>
  );
}

// ---------- deck list ----------
function DeckList({ state, update, setView }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  const stats = (id) => {
    const cs = state.cards.filter((c) => c.deck === id);
    return { total: cs.length, due: cs.filter(isDue).length };
  };

  const add = () => {
    if (!name.trim()) return;
    update((s) => {
      s.decks.push({ id: uid(), name: name.trim(), desc: desc.trim() });
      return s;
    });
    setName(""); setDesc(""); setAdding(false);
  };

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <div>
          <h1 style={S.h1}>Mazos</h1>
          <p style={S.lede}>Colecciones de notas que repasas y enlazas entre sí.</p>
        </div>
        <button className="primary" style={S.primary} onClick={() => setAdding((v) => !v)}>
          {adding ? <X size={15} /> : <Plus size={15} />}
          {adding ? "Cancelar" : "Nuevo mazo"}
        </button>
      </div>

      {adding && (
        <div style={S.composer}>
          <input
            autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Nombre del mazo" style={S.inputLg}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <input
            value={desc} onChange={(e) => setDesc(e.target.value)}
            placeholder="Descripción (opcional)" style={S.input}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="primary" style={S.primary} onClick={add}>
            <Check size={15} /> Crear
          </button>
        </div>
      )}

      {state.decks.length === 0 ? (
        <Empty icon={Layers} title="Aún no hay mazos"
          body="Crea tu primer mazo para empezar a escribir notas y repasarlas." />
      ) : (
        <div style={S.grid}>
          {state.decks.map((d) => {
            const st = stats(d.id);
            return (
              <button key={d.id} className="card-tile" style={S.deck}
                onClick={() => setView({ name: "deck", deckId: d.id })}>
                <div style={S.deckTop}>
                  <span style={S.deckIcon}><Hash size={15} strokeWidth={2.2} /></span>
                  {st.due > 0 && <span style={S.dueBadge}>{st.due} por repasar</span>}
                </div>
                <h3 style={S.deckName}>{d.name}</h3>
                {d.desc && <p style={S.deckDesc}>{d.desc}</p>}
                <div style={S.deckMeta}>
                  <span style={S.metaItem}><BookOpen size={13} /> {st.total} notas</span>
                  <span style={S.metaItem}><Clock size={13} /> {st.due} hoy</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- deck detail ----------
function DeckDetail({ state, update, setView, deckId }) {
  const deck = state.decks.find((d) => d.id === deckId);
  const cards = state.cards.filter((c) => c.deck === deckId);
  const [editor, setEditor] = useState(null); // null | "new" | card
  const [q, setQ] = useState("");

  if (!deck) { setView({ name: "decks" }); return null; }

  const due = cards.filter(isDue).length;
  const filtered = cards.filter((c) =>
    !q.trim() || (c.front + c.back + c.tags.join(" ")).toLowerCase().includes(q.toLowerCase())
  );

  const removeDeck = () => {
    if (!confirm(`¿Eliminar el mazo “${deck.name}” y sus ${cards.length} notas?`)) return;
    update((s) => {
      s.decks = s.decks.filter((d) => d.id !== deckId);
      s.cards = s.cards.filter((c) => c.deck !== deckId);
      return s;
    });
    setView({ name: "decks" });
  };

  return (
    <div style={S.page}>
      <button style={S.back} className="back" onClick={() => setView({ name: "decks" })}>
        <ChevronLeft size={16} /> Mazos
      </button>

      <div style={S.pageHead}>
        <div>
          <h1 style={S.h1}>{deck.name}</h1>
          <p style={S.lede}>{deck.desc || "Sin descripción"}</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="ghost" style={S.ghostDanger} onClick={removeDeck}>
            <Trash2 size={15} /> Eliminar mazo
          </button>
          <button className="ghost" style={{ ...S.ghost, opacity: cards.length >= 1 ? 1 : 0.45, cursor: cards.length >= 1 ? "pointer" : "not-allowed" }}
            disabled={cards.length < 1}
            onClick={() => cards.length >= 1 && setView({ name: "examSetup", deckId })}>
            <FileText size={15} /> Examen
          </button>
          <button className="primary" style={{ ...S.primary, opacity: due ? 1 : 0.45, cursor: due ? "pointer" : "not-allowed" }}
            disabled={!due}
            onClick={() => due && setView({ name: "study", deckId })}>
            <Play size={15} /> Estudiar {due > 0 && `(${due})`}
          </button>
        </div>
      </div>

      <div style={S.toolbar}>
        <div style={S.searchWrap}>
          <Search size={15} color={C.faint} />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar en este mazo" style={S.searchInput} />
        </div>
        <button className="primary" style={S.primary} onClick={() => setEditor("new")}>
          <Plus size={15} /> Nueva nota
        </button>
      </div>

      {filtered.length === 0 ? (
        <Empty icon={BookOpen} title={q ? "Sin resultados" : "Mazo vacío"}
          body={q ? "Ninguna nota coincide con tu búsqueda." : "Añade tu primera nota a este mazo."} />
      ) : (
        <div style={S.cardList}>
          {filtered.map((c) => (
            <CardRow key={c.id} card={c} state={state} onEdit={() => setEditor(c)} />
          ))}
        </div>
      )}

      {editor && (
        <CardEditor
          deckId={deckId}
          card={editor === "new" ? null : editor}
          state={state}
          update={update}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function CardRow({ card, _state, onEdit }) {
  const due = isDue(card);
  const links = card.links?.length || 0;
  const g = card.srs?.lastGrade ? GRADES[card.srs.lastGrade] : null;
  return (
    <button className="card-tile" style={S.row} onClick={onEdit}>
      <div style={S.rowMain}>
        <div style={S.rowFront}>{card.front}</div>
        <div style={S.rowBack}>{card.back}</div>
        {card.tags.length > 0 && (
          <div style={S.tagRow}>
            {card.tags.map((t) => <span key={t} style={S.tag}>{t}</span>)}
          </div>
        )}
      </div>
      <div style={S.rowSide}>
        <span style={{ ...S.statDot, background: due ? C.accent : C.line }} />
        <span style={S.rowStat}>{due ? "por repasar" : nextLabel(card)}</span>
        {links > 0 && <span style={S.rowStat}><Link2 size={12} /> {links}</span>}
        {g && <span style={{ ...S.gradeTick, color: g.accent }}>{g.label}</span>}
        <Edit2 size={14} color={C.faint} />
      </div>
    </button>
  );
}
function nextLabel(card) {
  if (!card.srs?.due) return "nueva";
  const days = Math.round((card.srs.due - Date.now()) / DAY);
  if (days <= 0) return "hoy";
  if (days === 1) return "mañana";
  return `en ${days} d`;
}

// ---------- card editor (with Zettelkasten links) ----------
function CardEditor({ deckId, card, state, update, onClose }) {
  const [front, setFront] = useState(card?.front || "");
  const [back, setBack] = useState(card?.back || "");
  const [tags, setTags] = useState(card?.tags?.join(", ") || "");
  const [links, setLinks] = useState(card?.links || []);
  const [linkQ, setLinkQ] = useState("");
  const isNew = !card;

  const others = state.cards.filter((c) => c.id !== card?.id);
  const matches = linkQ.trim()
    ? others.filter((c) => !links.includes(c.id) &&
        c.front.toLowerCase().includes(linkQ.toLowerCase())).slice(0, 6)
    : [];
  const linked = others.filter((c) => links.includes(c.id));

  const save = () => {
    if (!front.trim() || !back.trim()) return;
    const tagArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
    update((s) => {
      if (isNew) {
        const id = uid();
        s.cards.push({ id, deck: deckId, front: front.trim(), back: back.trim(),
          tags: tagArr, links, srs: null, created: Date.now() });
        // make links bidirectional
        links.forEach((lid) => {
          const t = s.cards.find((c) => c.id === lid);
          if (t && !t.links.includes(id)) t.links.push(id);
        });
      } else {
        const c = s.cards.find((x) => x.id === card.id);
        const removed = c.links.filter((l) => !links.includes(l));
        c.front = front.trim(); c.back = back.trim(); c.tags = tagArr; c.links = links;
        links.forEach((lid) => {
          const t = s.cards.find((x) => x.id === lid);
          if (t && !t.links.includes(c.id)) t.links.push(c.id);
        });
        removed.forEach((lid) => {
          const t = s.cards.find((x) => x.id === lid);
          if (t) t.links = t.links.filter((l) => l !== c.id);
        });
      }
      return s;
    });
    onClose();
  };

  const remove = () => {
    if (!confirm("¿Eliminar esta nota?")) return;
    update((s) => {
      s.cards = s.cards.filter((c) => c.id !== card.id);
      s.cards.forEach((c) => { c.links = c.links.filter((l) => l !== card.id); });
      return s;
    });
    onClose();
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>{isNew ? "Nueva nota" : "Editar nota"}</h2>
          <button className="iconbtn" style={S.iconBtn} onClick={onClose}><X size={18} /></button>
        </div>

        <div style={S.field}>
          <label style={S.label}>Anverso · la pregunta o el concepto</label>
          <textarea autoFocus value={front} onChange={(e) => setFront(e.target.value)}
            placeholder="¿Qué quieres recordar?" style={S.textareaFront} rows={2} />
        </div>
        <div style={S.field}>
          <label style={S.label}>Reverso · la respuesta</label>
          <textarea value={back} onChange={(e) => setBack(e.target.value)}
            placeholder="La idea, en una sola unidad." style={S.textarea} rows={3} />
        </div>
        <div style={S.field}>
          <label style={S.label}>Etiquetas · separadas por comas</label>
          <input value={tags} onChange={(e) => setTags(e.target.value)}
            placeholder="método, srs" style={S.input} />
        </div>

        <div style={S.field}>
          <label style={S.label}><Link2 size={13} /> Enlaces · conecta esta nota con otras</label>
          {linked.length > 0 && (
            <div style={S.linkChips}>
              {linked.map((c) => (
                <span key={c.id} style={S.linkChip}>
                  {trunc(c.front, 32)}
                  <button className="iconbtn" style={S.chipX}
                    onClick={() => setLinks(links.filter((l) => l !== c.id))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input value={linkQ} onChange={(e) => setLinkQ(e.target.value)}
            placeholder="Buscar nota para enlazar…" style={S.input} />
          {matches.length > 0 && (
            <div style={S.linkResults}>
              {matches.map((c) => (
                <button key={c.id} className="link-result" style={S.linkResult}
                  onClick={() => { setLinks([...links, c.id]); setLinkQ(""); }}>
                  <Plus size={13} color={C.accent} /> {trunc(c.front, 48)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={S.modalFoot}>
          {!isNew && (
            <button className="ghost" style={S.ghostDanger} onClick={remove}>
              <Trash2 size={15} /> Eliminar
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="ghost" style={S.ghost} onClick={onClose}>Cancelar</button>
          <button className="primary" style={{ ...S.primary, opacity: front.trim() && back.trim() ? 1 : 0.45 }}
            onClick={save}>
            <Check size={15} /> Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- study session ----------
function Study({ state, update, setView, deckId, logStudy }) {
  const deck = state.decks.find((d) => d.id === deckId);
  const [queue, setQueue] = useState(() => state.cards.filter((c) => c.deck === deckId && isDue(c)).map((c) => c.id));
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const startQueue = useRef(queue.length);

  const current = state.cards.find((c) => c.id === queue[idx]);
  const linkedNotes = current ? state.cards.filter((c) => current.links?.includes(c.id)) : [];

  const grade = (key) => {
    const srs = schedule(current, key);
    update((s) => {
      const c = s.cards.find((x) => x.id === current.id);
      c.srs = srs;
      return s;
    });
    // every graded card counts toward goal/streak; "again" still rewards the effort
    logStudy?.(1);
    setDone((d) => d + 1);
    let q = queue;
    if (key === "again") {
      // requeue near the end of this session
      q = [...queue.slice(0, idx), ...queue.slice(idx + 1), queue[idx]];
      setQueue(q);
      setRevealed(false);
      // idx stays, now points to next card (since we removed current)
      if (idx >= q.length) setIdx(0);
    } else {
      const next = queue.filter((_, i) => i !== idx);
      setQueue(next);
      setRevealed(false);
      if (idx >= next.length) setIdx(0);
    }
  };

  // keyboard
  useEffect(() => {
    const h = (e) => {
      if (!current) return;
      if (e.code === "Space") { e.preventDefault(); setRevealed((r) => !r); }
      if (revealed) {
        if (e.key === "1") grade("again");
        if (e.key === "2") grade("hard");
        if (e.key === "3") grade("good");
        if (e.key === "4") grade("easy");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  if (!current) {
    return (
      <div style={S.page}>
        <div style={S.doneCard}>
          <span style={S.doneMark}><Check size={26} strokeWidth={2.5} /></span>
          <h1 style={S.h1}>Sesión completa</h1>
          <p style={S.lede}>Repasaste {done} nota{done === 1 ? "" : "s"} de “{deck?.name}”. Vuelve cuando toque el próximo repaso.</p>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button className="ghost" style={S.ghost} onClick={() => setView({ name: "deck", deckId })}>
              <ChevronLeft size={15} /> Volver al mazo
            </button>
            <button className="primary" style={S.primary} onClick={() => setView({ name: "decks" })}>
              <BookOpen size={15} /> Todos los mazos
            </button>
          </div>
        </div>
      </div>
    );
  }

  const progress = startQueue.current ? done / (done + queue.length) : 0;

  return (
    <div style={S.page}>
      <div style={S.studyTop}>
        <button style={S.back} className="back" onClick={() => setView({ name: "deck", deckId })}>
          <X size={16} /> Salir
        </button>
        <div style={S.progressTrack}>
          <div style={{ ...S.progressFill, width: `${progress * 100}%` }} />
        </div>
        <span style={S.counter}>{queue.length} restantes</span>
      </div>

      <div style={S.stage}>
        <div className="flashcard" style={S.flashcard} onClick={() => setRevealed((r) => !r)}>
          <div style={S.face}>
            <span style={S.faceTag}>{revealed ? "reverso" : "anverso"}</span>
            <p style={revealed ? S.faceBack : S.faceFront}>
              {revealed ? current.back : current.front}
            </p>
            {revealed && current.tags.length > 0 && (
              <div style={S.tagRow}>
                {current.tags.map((t) => <span key={t} style={S.tag}>{t}</span>)}
              </div>
            )}
            {revealed && linkedNotes.length > 0 && (
              <div style={S.linkedBox}>
                <span style={S.linkedHead}><Link2 size={12} /> Notas enlazadas</span>
                {linkedNotes.map((n) => (
                  <span key={n.id} style={S.linkedItem}>{trunc(n.front, 56)}</span>
                ))}
              </div>
            )}
          </div>
          {!revealed && <span style={S.flip}>toca o pulsa espacio para revelar</span>}
        </div>
      </div>

      {revealed ? (
        <div style={S.grades}>
          {Object.entries(GRADES).map(([k, g], i) => (
            <button key={k} className="grade" style={{ ...S.gradeBtn, "--ga": g.accent }}
              onClick={() => grade(k)}>
              <span style={{ ...S.gradeDot, background: g.accent }} />
              <span style={S.gradeLabel}>{g.label}</span>
              <span style={S.gradeHint}>{g.hint}</span>
              <span style={S.gradeNext}>{previewInterval(current, k)}</span>
              <span style={S.gradeKey}>{i + 1}</span>
            </button>
          ))}
        </div>
      ) : (
        <div style={S.revealBar}>
          <button className="primary" style={S.revealBtn} onClick={() => setRevealed(true)}>
            <Zap size={16} /> Revelar respuesta
          </button>
        </div>
      )}
    </div>
  );
}
function previewInterval(card, key) {
  const { interval } = schedule(card, key);
  if (interval === 0) return "ahora";
  if (interval === 1) return "1 día";
  return `${interval} días`;
}

// ---------- graph / constellation ----------
function Graph({ state, setView }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [hover, setHover] = useState(null);
  const [sel, setSel] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: Math.max(420, el.clientHeight) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const deckColor = useMemo(() => {
    const pal = ["#4a6f8a", "#4f7a52", "#c08a2e", "#8a5a7a", "#b4413c", "#3f7a78"];
    const m = {};
    state.decks.forEach((d, i) => (m[d.id] = pal[i % pal.length]));
    return m;
  }, [state.decks]);

  // force-ish layout (deterministic, few iterations)
  const nodes = useMemo(() => {
    const cs = state.cards;
    const n = cs.length;
    const cx = size.w / 2, cy = size.h / 2;
    const R = Math.min(size.w, size.h) * 0.36;
    const pos = {};
    cs.forEach((c, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      pos[c.id] = { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, vx: 0, vy: 0 };
    });
    const idset = new Set(cs.map((c) => c.id));
    for (let iter = 0; iter < 120; iter++) {
      cs.forEach((a) => {
        let fx = 0, fy = 0;
        cs.forEach((b) => {
          if (a.id === b.id) return;
          const dx = pos[a.id].x - pos[b.id].x, dy = pos[a.id].y - pos[b.id].y;
          let d2 = dx * dx + dy * dy || 0.01;
          const rep = 1800 / d2;
          fx += dx * rep; fy += dy * rep;
        });
        (a.links || []).forEach((lid) => {
          if (!idset.has(lid)) return;
          const dx = pos[lid].x - pos[a.id].x, dy = pos[lid].y - pos[a.id].y;
          fx += dx * 0.015; fy += dy * 0.015;
        });
        fx += (cx - pos[a.id].x) * 0.012;
        fy += (cy - pos[a.id].y) * 0.012;
        pos[a.id].vx = (pos[a.id].vx + fx) * 0.82;
        pos[a.id].vy = (pos[a.id].vy + fy) * 0.82;
      });
      cs.forEach((a) => {
        pos[a.id].x += pos[a.id].vx;
        pos[a.id].y += pos[a.id].vy;
        pos[a.id].x = Math.max(34, Math.min(size.w - 34, pos[a.id].x));
        pos[a.id].y = Math.max(34, Math.min(size.h - 34, pos[a.id].y));
      });
    }
    return pos;
  }, [state.cards, size]);

  const edges = useMemo(() => {
    const seen = new Set(), out = [];
    state.cards.forEach((c) => (c.links || []).forEach((l) => {
      const k = [c.id, l].sort().join("|");
      if (seen.has(k) || !nodes[l]) return;
      seen.add(k); out.push([c.id, l]);
    }));
    return out;
  }, [state.cards, nodes]);

  const active = hover || sel;
  const neighbors = useMemo(() => {
    if (!active) return null;
    const c = state.cards.find((x) => x.id === active);
    const set = new Set([active, ...(c?.links || [])]);
    edges.forEach(([a, b]) => {
      if (a === active) set.add(b);
      if (b === active) set.add(a);
    });
    return set;
  }, [active, edges, state.cards]);

  const selCard = sel && state.cards.find((c) => c.id === sel);

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <div>
          <h1 style={S.h1}>Constelación</h1>
          <p style={S.lede}>Cada punto es una nota; cada hilo, un enlace que tú trazaste. El conocimiento vive en las conexiones.</p>
        </div>
      </div>

      <div style={S.legend}>
        {state.decks.map((d) => (
          <span key={d.id} style={S.legendItem}>
            <span style={{ ...S.legendDot, background: deckColor[d.id] }} /> {d.name}
          </span>
        ))}
      </div>

      <div ref={wrapRef} style={S.graphWrap}>
        {state.cards.length === 0 ? (
          <Empty icon={GitBranch} title="Sin notas todavía"
            body="Crea notas y enlázalas para ver tu constelación crecer." />
        ) : (
          <svg width={size.w} height={size.h} style={{ display: "block" }}>
            {edges.map(([a, b], i) => {
              const on = !active || (neighbors?.has(a) && neighbors?.has(b));
              return (
                <line key={i} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y}
                  stroke={on ? C.accent : C.line}
                  strokeOpacity={on ? (active ? 0.55 : 0.3) : 0.12}
                  strokeWidth={on && active ? 1.4 : 1} />
              );
            })}
            {state.cards.map((c) => {
              const p = nodes[c.id];
              const on = !active || neighbors?.has(c.id);
              const r = active === c.id ? 9 : 6 + Math.min(4, (c.links?.length || 0));
              return (
                <g key={c.id} style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)}
                  onClick={() => setSel(sel === c.id ? null : c.id)}>
                  <circle cx={p.x} cy={p.y} r={r + 6} fill="transparent" />
                  <circle cx={p.x} cy={p.y} r={r}
                    fill={on ? deckColor[c.deck] : C.line}
                    fillOpacity={on ? 1 : 0.35}
                    stroke={C.paper} strokeWidth={2} />
                  {(active === c.id || (!active && (c.links?.length || 0) >= 2)) && (
                    <text x={p.x} y={p.y - r - 8} textAnchor="middle"
                      style={{ font: `500 11px ${F.ui}`, fill: C.ink }}>
                      {trunc(c.front, 26)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {selCard && (
          <div style={S.graphPanel}>
            <div style={S.modalHead}>
              <span style={S.faceTag}>{state.decks.find((d) => d.id === selCard.deck)?.name}</span>
              <button className="iconbtn" style={S.iconBtn} onClick={() => setSel(null)}><X size={16} /></button>
            </div>
            <p style={S.panelFront}>{selCard.front}</p>
            <p style={S.panelBack}>{selCard.back}</p>
            <button className="ghost" style={{ ...S.ghost, marginTop: 14 }}
              onClick={() => setView({ name: "deck", deckId: selCard.deck })}>
              <ChevronLeft size={14} /> Abrir mazo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  EXAM ENGINE — algorithmic, no AI
//  Builds questions purely from deck cards via tokenization,
//  lexical overlap for distractors, and seeded shuffling.
// ============================================================

const STOP = new Set([
  "el","la","los","las","un","una","unos","unas","de","del","al","a","y","o","u",
  "que","qué","como","cómo","con","sin","por","para","en","es","son","se","su","sus",
  "lo","le","les","mi","tu","si","sí","no","ni","más","menos","muy","ya","entre",
  "cada","todo","toda","todos","todas","este","esta","estos","estas","ese","esa",
  "donde","cuando","cual","cuál","the","of","a","an","and","or","to","is","are","in",
  "on","for","that","this","it","as","be","by","with","from","puede","cuyo","cuya",
]);

// deterministic PRNG so a given exam is stable while taken
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ");
function tokens(s) {
  return norm(s).split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}
// shared significant-word ratio between two texts (0..1)
function overlap(a, b) {
  const ta = new Set(tokens(a)), tb = tokens(b);
  if (!ta.size || !tb.length) return 0;
  let hit = 0;
  const counted = new Set();
  tb.forEach((w) => { if (ta.has(w) && !counted.has(w)) { hit++; counted.add(w); } });
  return hit / ta.size;
}

// pick the most lexically-similar other cards as plausible distractors
function pickDistractors(target, pool, count, rnd) {
  const scored = pool
    .filter((c) => c.id !== target.id && c.back.trim() && c.back.trim() !== target.back.trim())
    .map((c) => ({ c, s: overlap(target.back, c.back) + overlap(target.front, c.front) * 0.5 }));
  // dedupe identical backs
  const seen = new Set();
  const uniq = scored.filter(({ c }) => {
    const k = norm(c.back);
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  // similar ones first, then fill randomly so it's not always the same set
  const similar = uniq.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c);
  const rest = shuffle(uniq.filter((x) => x.s === 0).map((x) => x.c), rnd);
  const ordered = [...similar.slice(0, count), ...rest];
  return ordered.slice(0, count);
}

function buildExam(cards, types, length, seed) {
  const usable = cards.filter((c) => c.front.trim() && c.back.trim());
  const rnd = mulberry32(seed);
  const chosen = shuffle(usable, rnd).slice(0, Math.min(length, usable.length));
  const canMC = usable.length >= 3; // need correct + 2 distractors minimum
  const canTF = usable.length >= 2;

  return chosen.map((card, i) => {
    // decide this question's type from the allowed set, respecting feasibility
    let allowed = types.filter((t) =>
      t === "open" || (t === "mc" && canMC) || (t === "tf" && canTF)
    );
    if (!allowed.length) allowed = ["open"];
    const type = allowed[Math.floor(rnd() * allowed.length)];

    if (type === "mc") {
      const nOpts = 2 + Math.floor(rnd() * 3); // 3..4 total options, min 2 distractors
      const distractors = pickDistractors(card, usable, Math.max(2, nOpts - 1), rnd);
      const options = shuffle([
        { text: card.back, correct: true },
        ...distractors.map((d) => ({ text: d.back, correct: false })),
      ], rnd);
      return { id: card.id + ":" + i, type, prompt: card.front, options, answerText: card.back };
    }
    if (type === "tf") {
      const makeTrue = rnd() < 0.5;
      let shown = card.back, isTrue = true;
      if (!makeTrue) {
        const others = pickDistractors(card, usable, 1, rnd);
        if (others.length) { shown = others[0].back; isTrue = false; }
      }
      return {
        id: card.id + ":" + i, type,
        prompt: card.front, statement: shown, isTrue,
        answerText: card.back,
      };
    }
    // open / development
    return {
      id: card.id + ":" + i, type: "open",
      prompt: card.front, answerText: card.back,
      keywords: tokens(card.back),
    };
  });
}

// auto-grade an open answer by significant-keyword recall
function gradeOpen(userText, q) {
  const have = new Set(tokens(userText));
  if (!q.keywords.length) return { ratio: userText.trim() ? 1 : 0, matched: [], missed: [] };
  const matched = [], missed = [];
  q.keywords.forEach((k) => (have.has(k) ? matched : missed).push(k));
  return { ratio: matched.length / q.keywords.length, matched, missed };
}

// ---------- exam setup ----------
function ExamSetup({ state, setView, deckId }) {
  const deck = state.decks.find((d) => d.id === deckId);
  const cards = state.cards.filter((c) => c.deck === deckId && c.front.trim() && c.back.trim());
  const [types, setTypes] = useState({ open: true, mc: true, tf: true });
  const [length, setLength] = useState(Math.min(10, cards.length));

  if (!deck) { setView({ name: "decks" }); return null; }

  const canMC = cards.length >= 3, canTF = cards.length >= 2;
  const active = Object.entries(types).filter(([, v]) => v).map(([k]) => k);
  const ready = active.length > 0 && cards.length >= 1;

  const toggle = (k) => setTypes((t) => ({ ...t, [k]: !t[k] }));

  const start = () => {
    const allowed = active.filter((t) => t === "open" || (t === "mc" && canMC) || (t === "tf" && canTF));
    setView({
      name: "exam",
      config: { deckId, types: allowed.length ? allowed : ["open"], length, seed: Date.now() % 2147483647 },
    });
  };

  const TYPE_META = [
    { k: "open", icon: AlignLeft, name: "Desarrollo", desc: "Escribes la respuesta; se corrige por palabras clave.", ok: true },
    { k: "mc", icon: List, name: "Selección múltiple", desc: "2 a 4 opciones; los distractores salen de otras notas.", ok: canMC, need: "Requiere 3+ notas" },
    { k: "tf", icon: ToggleLeft, name: "Verdadero o falso", desc: "Empareja anverso y reverso, a veces cambiado.", ok: canTF, need: "Requiere 2+ notas" },
  ];

  return (
    <div style={S.page}>
      <button style={S.back} className="back" onClick={() => setView({ name: "deck", deckId })}>
        <ChevronLeft size={16} /> {deck.name}
      </button>
      <div style={S.pageHead}>
        <div>
          <h1 style={S.h1}>Nuevo examen</h1>
          <p style={S.lede}>Las preguntas se generan a partir de tus {cards.length} notas con un algoritmo, sin IA.</p>
        </div>
      </div>

      <div style={S.examForm}>
        <div style={S.field}>
          <label style={S.label}>Tipos de pregunta</label>
          <div style={S.typeGrid}>
            {TYPE_META.map(({ k, icon: Icon, name, desc, ok, need }) => {
              const on = types[k] && ok;
              return (
                <button key={k} className="type-opt"
                  style={{ ...S.typeOpt, ...(on ? S.typeOptOn : {}), opacity: ok ? 1 : 0.5, cursor: ok ? "pointer" : "not-allowed" }}
                  onClick={() => ok && toggle(k)} disabled={!ok}>
                  <span style={{ ...S.typeCheck, ...(on ? S.typeCheckOn : {}) }}>
                    {on && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span style={{ ...S.typeIcon, color: on ? C.accent : C.faint }}><Icon size={18} /></span>
                  <span style={S.typeName}>{name}</span>
                  <span style={S.typeDesc}>{ok ? desc : need}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={S.field}>
          <label style={S.label}>Número de preguntas · {length}</label>
          <input type="range" min={1} max={cards.length} value={length}
            onChange={(e) => setLength(Number(e.target.value))} style={S.range} />
          <div style={S.rangeEnds}><span>1</span><span>{cards.length}</span></div>
        </div>

        <button className="primary" style={{ ...S.primary, opacity: ready ? 1 : 0.45, cursor: ready ? "pointer" : "not-allowed", alignSelf: "flex-start" }}
          disabled={!ready} onClick={start}>
          <Play size={15} /> Empezar examen
        </button>
      </div>
    </div>
  );
}

// ---------- exam runner ----------
function Exam({ state, setView, config, logStudy }) {
  const deck = state.decks.find((d) => d.id === config.deckId);
  const cards = useMemo(() => state.cards.filter((c) => c.deck === config.deckId), [state, config.deckId]);
  const questions = useMemo(
    () => buildExam(cards, config.types, config.length, config.seed),
    [cards, config]
  );

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({}); // id -> { value, correct, ratio }
  const [input, setInput] = useState("");
  const [checked, setChecked] = useState(false);
  const [finished, setFinished] = useState(false);
  const logged = useRef(false);

  const q = questions[idx];

  if (!deck || !q) {
    return (
      <div style={S.page}>
        <Empty icon={FileText} title="No se pudo generar el examen"
          body="Añade notas con anverso y reverso para crear preguntas." />
        <div style={{ display: "grid", placeItems: "center", marginTop: 18 }}>
          <button className="ghost" style={S.ghost} onClick={() => setView({ name: "deck", deckId: config.deckId })}>
            <ChevronLeft size={15} /> Volver
          </button>
        </div>
      </div>
    );
  }

  const submit = (payload) => {
    setAnswers((a) => ({ ...a, [q.id]: payload }));
    setChecked(true);
  };

  const checkOpen = () => {
    const g = gradeOpen(input, q);
    const correct = g.ratio >= 0.5;
    submit({ type: "open", value: input, correct, ratio: g.ratio, matched: g.matched, missed: g.missed });
  };
  const checkMC = (opt) => {
    if (checked) return;
    submit({ type: "mc", value: opt.text, correct: !!opt.correct });
  };
  const checkTF = (val) => {
    if (checked) return;
    submit({ type: "tf", value: val, correct: val === q.isTrue });
  };
  const overrideOpen = (correct) => {
    setAnswers((a) => ({ ...a, [q.id]: { ...a[q.id], correct, overridden: true } }));
  };

  const next = () => {
    if (idx + 1 >= questions.length) { setFinished(true); return; }
    setIdx(idx + 1); setInput(""); setChecked(false);
  };

  if (finished) {
    if (!logged.current) {
      logged.current = true;
      const correct = questions.filter((qq) => answers[qq.id]?.correct).length;
      const pct = Math.round((correct / questions.length) * 100);
      logStudy?.(questions.length, { exam: true, examDone: true, examPct: pct });
    }
    return <ExamResult questions={questions} answers={answers} deck={deck}
      setView={setView} config={config} />;
  }

  const ans = answers[q.id];
  const TYPE_LABEL = { open: "Desarrollo", mc: "Selección múltiple", tf: "Verdadero o falso" };

  return (
    <div style={S.page}>
      <div style={S.studyTop}>
        <button style={S.back} className="back" onClick={() => { if (confirm("¿Salir del examen? Se perderá el progreso.")) setView({ name: "deck", deckId: config.deckId }); }}>
          <X size={16} /> Salir
        </button>
        <div style={S.progressTrack}>
          <div style={{ ...S.progressFill, width: `${(idx / questions.length) * 100}%` }} />
        </div>
        <span style={S.counter}>{idx + 1} / {questions.length}</span>
      </div>

      <div style={S.examCard}>
        <span style={S.faceTag}>{TYPE_LABEL[q.type]}</span>
        <p style={S.examPrompt}>{q.prompt}</p>

        {q.type === "open" && (
          <div>
            <textarea autoFocus={!checked} value={checked ? ans.value : input}
              onChange={(e) => setInput(e.target.value)} disabled={checked}
              placeholder="Escribe tu respuesta…" rows={4}
              style={{ ...S.textarea, opacity: checked ? 0.8 : 1 }}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !checked) checkOpen(); }} />
            {!checked ? (
              <button className="primary" style={{ ...S.primary, marginTop: 14, opacity: input.trim() ? 1 : 0.45 }}
                disabled={!input.trim()} onClick={checkOpen}>
                <Check size={15} /> Comprobar
              </button>
            ) : (
              <OpenFeedback ans={ans} q={q} onOverride={overrideOpen} />
            )}
          </div>
        )}

        {q.type === "mc" && (
          <div style={S.options}>
            {q.options.map((opt, i) => {
              const picked = ans?.value === opt.text;
              let st = { ...S.option };
              if (checked) {
                if (opt.correct) st = { ...st, ...S.optionCorrect };
                else if (picked) st = { ...st, ...S.optionWrong };
                else st = { ...st, opacity: 0.55 };
              }
              return (
                <button key={i} className={checked ? "" : "option"} style={st}
                  disabled={checked} onClick={() => checkMC(opt)}>
                  <span style={S.optMark}>{String.fromCharCode(65 + i)}</span>
                  <span style={S.optText}>{opt.text}</span>
                  {checked && opt.correct && <CheckCircle size={17} color={C.success} />}
                  {checked && picked && !opt.correct && <XCircle size={17} color={C.danger} />}
                </button>
              );
            })}
          </div>
        )}

        {q.type === "tf" && (
          <div>
            <div style={S.tfStatement}>{q.statement}</div>
            <div style={S.tfRow}>
              {[true, false].map((val) => {
                const picked = ans?.value === val;
                let st = { ...S.tfBtn };
                if (checked) {
                  if (val === q.isTrue) st = { ...st, ...S.optionCorrect };
                  else if (picked) st = { ...st, ...S.optionWrong };
                  else st = { ...st, opacity: 0.5 };
                }
                return (
                  <button key={String(val)} className={checked ? "" : "option"} style={st}
                    disabled={checked} onClick={() => checkTF(val)}>
                    {val ? <CheckCircle size={17} /> : <XCircle size={17} />}
                    {val ? "Verdadero" : "Falso"}
                  </button>
                );
              })}
            </div>
            {checked && !q.isTrue && (
              <div style={S.tfCorrect}>
                <span style={S.faceTag}>respuesta correcta</span>
                <p style={{ margin: "6px 0 0", fontSize: 14.5, lineHeight: 1.5 }}>{q.answerText}</p>
              </div>
            )}
          </div>
        )}

        {checked && (
          <div style={S.nextRow}>
            <span style={{ ...S.verdict, color: ans.correct ? C.success : C.danger }}>
              {ans.correct ? <><CheckCircle size={16} /> Correcto</> : <><XCircle size={16} /> Incorrecto</>}
            </span>
            <button className="primary" style={S.primary} onClick={next}>
              {idx + 1 >= questions.length ? <>Ver resultado <Award size={15} /></> : <>Siguiente <ArrowRight size={15} /></>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function OpenFeedback({ ans, q, onOverride }) {
  return (
    <div style={S.openFb}>
      <div style={S.openModel}>
        <span style={S.faceTag}>respuesta esperada</span>
        <p style={{ margin: "6px 0 0", fontSize: 14.5, lineHeight: 1.55 }}>{q.answerText}</p>
      </div>
      {q.keywords.length > 0 && (
        <div style={S.kwBlock}>
          <span style={S.kwLabel}>Coincidencia de conceptos · {Math.round(ans.ratio * 100)}%</span>
          <div style={S.kwBar}><div style={{ ...S.kwFill, width: `${ans.ratio * 100}%`, background: ans.correct ? C.success : C.warn }} /></div>
          <div style={S.kwTags}>
            {ans.matched?.map((k) => <span key={k} style={{ ...S.kwTag, ...S.kwHit }}><Check size={11} /> {k}</span>)}
            {ans.missed?.map((k) => <span key={k} style={{ ...S.kwTag, ...S.kwMiss }}>{k}</span>)}
          </div>
        </div>
      )}
      <div style={S.overrideRow}>
        <span style={S.overrideHint}>¿La autocorrección acertó? Ajústala:</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ghost" style={{ ...S.ghost, padding: "7px 12px", color: ans.correct ? C.success : C.sub, borderColor: ans.correct ? C.success : C.line }}
            onClick={() => onOverride(true)}><Check size={14} /> Acerté</button>
          <button className="ghost" style={{ ...S.ghost, padding: "7px 12px", color: !ans.correct ? C.danger : C.sub, borderColor: !ans.correct ? C.danger : C.line }}
            onClick={() => onOverride(false)}><X size={14} /> Fallé</button>
        </div>
      </div>
    </div>
  );
}

function ExamResult({ questions, answers, deck, setView, config }) {
  const correct = questions.filter((q) => answers[q.id]?.correct).length;
  const pct = Math.round((correct / questions.length) * 100);
  const band = pct >= 85 ? { t: "Excelente", c: C.success } : pct >= 60 ? { t: "Aprobado", c: C.accent } : { t: "A repasar", c: C.warn };
  const TYPE_LABEL = { open: "Desarrollo", mc: "Selección múltiple", tf: "V / F" };

  return (
    <div style={S.page}>
      <div style={S.resultHero}>
        <span style={{ ...S.resultRing, borderColor: band.c, color: band.c }}>{pct}%</span>
        <h1 style={S.h1}>{band.t}</h1>
        <p style={S.lede}>Acertaste {correct} de {questions.length} preguntas en “{deck.name}”.</p>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button className="ghost" style={S.ghost} onClick={() => setView({ name: "deck", deckId: config.deckId })}>
            <ChevronLeft size={15} /> Volver al mazo
          </button>
          <button className="primary" style={S.primary} onClick={() => setView({ name: "examSetup", deckId: config.deckId })}>
            <RotateCcw size={15} /> Otro examen
          </button>
        </div>
      </div>

      <div style={S.reviewList}>
        {questions.map((q, i) => {
          const a = answers[q.id];
          const ok = a?.correct;
          return (
            <div key={q.id} style={S.reviewItem}>
              <span style={{ ...S.reviewIcon, color: ok ? C.success : C.danger }}>
                {ok ? <CheckCircle size={18} /> : <XCircle size={18} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.reviewTop}>
                  <span style={S.reviewNum}>{i + 1}</span>
                  <span style={S.reviewType}>{TYPE_LABEL[q.type]}</span>
                </div>
                <p style={S.reviewPrompt}>{q.prompt}</p>
                {!ok && (
                  <p style={S.reviewAnswer}>
                    {q.type === "tf"
                      ? `Correcto: ${q.isTrue ? "Verdadero" : "Falso"}`
                      : `Respuesta: ${q.answerText}`}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- progress / gamification hub ----------
function Progress({ state, update, setView, pushToast }) {
  const g = state.game;
  const lvl = levelOf(g.xp);
  const _prog = levelProgress(g.xp);
  const goalPct = Math.min(1, g.todayCount / g.goal);
  const earned = ACHIEVEMENTS.filter((a) => g.unlocked[a.id]).length;

  const setGoal = (val) => update((s) => { s.game.goal = val; return s; });

  const [reminded, setReminded] = useState(false);
  const setReminder = () => {
    setReminded(true);
    pushToast({ kind: "goal", title: "Recordatorio activado", body: `Vuelve cada día para no perder tu racha de ${g.streak}`, long: true });
  };

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <div>
          <h1 style={S.h1}>Tu progreso</h1>
          <p style={S.lede}>Las recompensas premian la constancia. La racha está protegida: cuesta perderla.</p>
        </div>
      </div>

      {/* stat band */}
      <div style={S.statBand}>
        <StatCard icon={<Flame size={20} color={C.flame} fill={g.streak > 0 ? C.flame : "none"} />}
          value={g.streak} label={`día${g.streak === 1 ? "" : "s"} de racha`}
          sub={g.best > 0 ? `mejor: ${g.best}` : "¡empieza hoy!"} tint={C.flameSoft} />
        <StatCard icon={<Lock size={18} color={C.accent} />}
          value={g.freezes} label={`protector${g.freezes === 1 ? "" : "es"}`}
          sub="absorben un día perdido" tint={C.accentSoft} />
        <StatCard icon={<TrendingUp size={19} color={C.success} />}
          value={`Nv ${lvl}`} label="nivel" sub={`${g.xp} XP`} tint={C.successSoft} />
        <StatCard icon={<Trophy size={18} color={C.warn} />}
          value={`${earned}/${ACHIEVEMENTS.length}`} label="logros" sub="desbloqueados" tint={C.warnSoft} />
      </div>

      {/* daily goal ring */}
      <div style={S.goalPanel}>
        <Ring pct={goalPct} done={goalPct >= 1} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.goalHead}>
            <h3 style={S.goalTitle}>Meta de hoy</h3>
            {goalPct >= 1 && <span style={S.goalDoneTag}><Check size={13} strokeWidth={3} /> cumplida</span>}
          </div>
          <p style={S.goalText}>
            {goalPct >= 1
              ? `Superaste tu meta con ${g.todayCount} tarjetas. La racha avanza.`
              : `Llevas ${g.todayCount} de ${g.goal} tarjetas. Te faltan ${g.goal - g.todayCount} para asegurar el día.`}
          </p>
          <div style={S.goalSetRow}>
            <span style={S.goalSetLabel}>Ajustar meta</span>
            {[5, 10, 15, 20].map((v) => (
              <button key={v} className="goalopt"
                style={{ ...S.goalOpt, ...(g.goal === v ? S.goalOptOn : {}) }}
                onClick={() => setGoal(v)}>{v}</button>
            ))}
          </div>
          <button className="ghost" style={{ ...S.ghost, marginTop: 14, color: reminded ? C.success : C.sub, borderColor: reminded ? C.success : C.line }} onClick={setReminder}>
            {reminded ? <><Check size={15} /> Recordatorio activado</> : <><Bell size={15} /> Recordarme cada día</>}
          </button>
        </div>
      </div>

      {/* achievements */}
      <h2 style={S.sectionTitle}>Logros</h2>
      <div style={S.achGrid}>
        {ACHIEVEMENTS.map((a) => {
          const on = !!g.unlocked[a.id];
          return (
            <div key={a.id} style={{ ...S.achCard, ...(on ? S.achCardOn : {}) }}>
              <span style={{ ...S.achIcon, ...(on ? S.achIconOn : {}) }}>
                {on ? <Icon name={a.icon} size={20} /> : <Lock size={16} color={C.faint} />}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ ...S.achName, color: on ? C.ink : C.faint }}>{a.name}</div>
                <div style={S.achDesc}>{a.desc}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", placeItems: "center", marginTop: 32 }}>
        <button className="primary" style={S.primary} onClick={() => setView({ name: "decks" })}>
          <BookOpen size={15} /> Ir a estudiar
        </button>
      </div>
    </div>
  );
}

function StatCard({ icon, value, label, sub, tint }) {
  return (
    <div style={S.statCard}>
      <span style={{ ...S.statIcon, background: tint }}>{icon}</span>
      <div style={S.statValue}>{value}</div>
      <div style={S.statLabel}>{label}</div>
      <div style={S.statSub}>{sub}</div>
    </div>
  );
}

function Ring({ pct, done }) {
  const r = 34, circ = 2 * Math.PI * r;
  return (
    <svg width={88} height={88} style={{ flexShrink: 0 }}>
      <circle cx={44} cy={44} r={r} fill="none" stroke={C.line} strokeWidth={8} />
      <circle cx={44} cy={44} r={r} fill="none"
        stroke={done ? C.success : C.accent} strokeWidth={8} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
        transform="rotate(-90 44 44)"
        style={{ transition: "stroke-dashoffset .6s cubic-bezier(.4,0,.2,1)" }} />
      <text x={44} y={44} textAnchor="middle" dominantBaseline="central"
        style={{ font: `700 18px ${F.ui}`, fill: done ? C.success : C.ink }}>
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

// ---------- toasts ----------
function ToastStack({ toasts }) {
  const meta = {
    goal:  { icon: <Target size={17} />,   tint: C.accentSoft,  color: C.accent },
    level: { icon: <TrendingUp size={17} />, tint: C.successSoft, color: C.success },
    ach:   { icon: <Trophy size={17} />,   tint: C.warnSoft,    color: C.warn },
  };
  return (
    <div style={S.toastStack}>
      {toasts.map((t) => {
        const m = meta[t.kind] || meta.goal;
        return (
          <div key={t.id} className="toast" style={S.toast}>
            <span style={{ ...S.toastIcon, background: m.tint, color: m.color }}>
              {t.icon ? <Icon name={t.icon} size={17} /> : m.icon}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={S.toastTitle}>{t.title}</div>
              <div style={S.toastBody}>{t.body}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- shared bits ----------
function Empty({ icon: IconC, title, body }) {
  return (
    <div style={S.empty}>
      <span style={S.emptyIcon}><IconC size={22} strokeWidth={1.8} /></span>
      <h3 style={S.emptyTitle}>{title}</h3>
      <p style={S.emptyBody}>{body}</p>
    </div>
  );
}
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------- design tokens ----------
const C = {
  paper: "#fbfaf7",
  panel: "#ffffff",
  ink: "#1f1d1a",
  sub: "#56524c",
  faint: "#9a948c",
  line: "#e6e2da",
  lineSoft: "#efece5",
  accent: "#3f6d8c",
  accentSoft: "#eef3f6",
  danger: "#b4413c",
  success: "#4f7a52",
  successSoft: "#eef4ee",
  warn: "#c08a2e",
  warnSoft: "#f7efdd",
  flame: "#d9742b",
  flameSoft: "#fbeede",
};
const F = {
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  ui: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

function Styles() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      @media (prefers-reduced-motion: no-preference) {
        .card-tile, .grade, .primary, .ghost, .navbtn, .iconbtn, .back, .link-result, .flashcard { transition: all .16s ease; }
      }
      .card-tile:hover { border-color: ${C.faint} !important; transform: translateY(-1px); }
      .grade:hover { border-color: var(--ga) !important; background: #fff !important; transform: translateY(-2px); }
      .primary:hover { background: #325873 !important; }
      .ghost:hover { background: ${C.lineSoft} !important; }
      .navbtn:hover { color: ${C.ink} !important; }
      .iconbtn:hover { background: ${C.lineSoft} !important; }
      .back:hover { color: ${C.ink} !important; }
      .link-result:hover { background: ${C.accentSoft} !important; }
      .option:hover { border-color: ${C.accent} !important; background: ${C.accentSoft} !important; }
      .type-opt:hover { border-color: ${C.faint} !important; }
      .flashcard:hover { box-shadow: 0 14px 40px -22px rgba(31,29,26,.4) !important; }
      .streakchip:hover { border-color: ${C.flame} !important; }
      .goalopt:hover { border-color: ${C.accent} !important; }
      .toast { animation: toastIn .34s cubic-bezier(.2,.9,.3,1.2); }
      @keyframes toastIn {
        from { opacity: 0; transform: translateY(14px) scale(.96); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .toast { animation: none; }
        * { transition: none !important; }
      }
      button:focus-visible, input:focus-visible, textarea:focus-visible {
        outline: 2px solid ${C.accent}; outline-offset: 2px;
      }
      input::placeholder, textarea::placeholder { color: ${C.faint}; }
      textarea, input { font-family: inherit; }
      ::selection { background: ${C.accentSoft}; }
    `}</style>
  );
}

// ---------- styles ----------
const S = {
  app: { minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: F.ui },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "16px 28px", borderBottom: `1px solid ${C.line}`,
    position: "sticky", top: 0, background: "rgba(251,250,247,.86)",
    backdropFilter: "blur(8px)", zIndex: 20,
  },
  brand: { display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", padding: 0 },
  brandMark: {
    width: 32, height: 32, borderRadius: 9, background: C.ink, color: C.paper,
    display: "grid", placeItems: "center",
  },
  brandText: { fontSize: 18, fontWeight: 600, letterSpacing: "-.01em", color: C.ink },
  nav: { display: "flex", gap: 4 },
  navBtn: {
    display: "flex", alignItems: "center", gap: 7, padding: "8px 13px",
    background: "none", border: "none", color: C.sub, fontSize: 14, fontWeight: 500,
    cursor: "pointer", borderRadius: 8,
  },
  navBtnActive: { color: C.ink, background: C.lineSoft },

  main: { maxWidth: 980, margin: "0 auto", padding: "36px 24px 80px" },
  page: {},
  pageHead: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, marginBottom: 26, flexWrap: "wrap" },
  h1: { fontFamily: F.serif, fontSize: 34, fontWeight: 600, margin: 0, letterSpacing: "-.02em", lineHeight: 1.05 },
  lede: { color: C.sub, fontSize: 15, margin: "8px 0 0", maxWidth: 520, lineHeight: 1.5 },

  primary: {
    display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px",
    background: C.accent, color: "#fff", border: "none", borderRadius: 9,
    fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  },
  ghost: {
    display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 15px",
    background: "transparent", color: C.sub, border: `1px solid ${C.line}`,
    borderRadius: 9, fontSize: 14, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap",
  },
  ghostDanger: {
    display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 15px",
    background: "transparent", color: C.danger, border: `1px solid ${C.line}`,
    borderRadius: 9, fontSize: 14, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap",
  },

  composer: {
    display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
    padding: 18, border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel, marginBottom: 24,
  },
  inputLg: {
    flex: "1 1 220px", padding: "11px 14px", border: `1px solid ${C.line}`, borderRadius: 9,
    fontSize: 16, fontWeight: 500, background: C.paper, color: C.ink,
  },
  input: {
    flex: "1 1 200px", padding: "11px 14px", border: `1px solid ${C.line}`, borderRadius: 9,
    fontSize: 14, background: C.paper, color: C.ink, width: "100%",
  },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))", gap: 16 },
  deck: {
    textAlign: "left", padding: 20, border: `1px solid ${C.line}`, borderRadius: 14,
    background: C.panel, cursor: "pointer", display: "flex", flexDirection: "column", gap: 10,
  },
  deckTop: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  deckIcon: { width: 30, height: 30, borderRadius: 8, background: C.accentSoft, color: C.accent, display: "grid", placeItems: "center" },
  dueBadge: { fontSize: 12, fontWeight: 600, color: C.accent, background: C.accentSoft, padding: "3px 9px", borderRadius: 20 },
  deckName: { fontFamily: F.serif, fontSize: 21, fontWeight: 600, margin: 0, color: C.ink },
  deckDesc: { fontSize: 13.5, color: C.sub, margin: 0, lineHeight: 1.45 },
  deckMeta: { display: "flex", gap: 16, marginTop: 4, paddingTop: 12, borderTop: `1px solid ${C.lineSoft}` },
  metaItem: { display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: C.faint, fontWeight: 500 },

  back: {
    display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none",
    color: C.sub, fontSize: 14, fontWeight: 500, cursor: "pointer", padding: 0, marginBottom: 18,
  },
  toolbar: { display: "flex", gap: 12, alignItems: "center", marginBottom: 20, flexWrap: "wrap" },
  searchWrap: {
    flex: "1 1 240px", display: "flex", alignItems: "center", gap: 9, padding: "10px 14px",
    border: `1px solid ${C.line}`, borderRadius: 9, background: C.panel,
  },
  searchInput: { flex: 1, border: "none", background: "none", fontSize: 14, color: C.ink, outline: "none" },

  cardList: { display: "flex", flexDirection: "column", gap: 10 },
  row: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    textAlign: "left", padding: "16px 18px", border: `1px solid ${C.line}`, borderRadius: 12,
    background: C.panel, cursor: "pointer", width: "100%",
  },
  rowMain: { minWidth: 0, flex: 1 },
  rowFront: { fontFamily: F.serif, fontSize: 16.5, fontWeight: 600, color: C.ink, marginBottom: 3 },
  rowBack: { fontSize: 13.5, color: C.sub, lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" },
  rowSide: { display: "flex", alignItems: "center", gap: 12, flexShrink: 0 },
  rowStat: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: C.faint, fontWeight: 500, whiteSpace: "nowrap" },
  statDot: { width: 7, height: 7, borderRadius: "50%" },
  gradeTick: { fontSize: 11, fontWeight: 600 },
  tagRow: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 },
  tag: { fontSize: 11.5, color: C.sub, background: C.lineSoft, padding: "2px 9px", borderRadius: 20, fontWeight: 500 },

  // editor modal
  overlay: {
    position: "fixed", inset: 0, background: "rgba(31,29,26,.32)", backdropFilter: "blur(3px)",
    display: "grid", placeItems: "center", padding: 20, zIndex: 60,
  },
  modal: {
    width: "min(560px, 100%)", maxHeight: "90vh", overflowY: "auto", background: C.panel,
    border: `1px solid ${C.line}`, borderRadius: 18, padding: 26,
    boxShadow: "0 30px 80px -30px rgba(31,29,26,.5)",
  },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 },
  modalTitle: { fontFamily: F.serif, fontSize: 22, fontWeight: 600, margin: 0 },
  iconBtn: { background: "none", border: "none", color: C.sub, cursor: "pointer", padding: 6, borderRadius: 8, display: "grid", placeItems: "center" },
  field: { marginBottom: 16 },
  label: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: C.sub, marginBottom: 7, letterSpacing: ".01em" },
  textareaFront: {
    width: "100%", padding: "12px 14px", border: `1px solid ${C.line}`, borderRadius: 10,
    fontSize: 16.5, fontFamily: F.serif, fontWeight: 600, color: C.ink, background: C.paper, resize: "vertical", lineHeight: 1.4,
  },
  textarea: {
    width: "100%", padding: "12px 14px", border: `1px solid ${C.line}`, borderRadius: 10,
    fontSize: 14.5, color: C.ink, background: C.paper, resize: "vertical", lineHeight: 1.5,
  },
  linkChips: { display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 },
  linkChip: {
    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, color: C.accent,
    background: C.accentSoft, padding: "4px 6px 4px 11px", borderRadius: 20, fontWeight: 500,
  },
  chipX: { background: "none", border: "none", color: C.accent, cursor: "pointer", padding: 2, display: "grid", placeItems: "center", borderRadius: "50%" },
  linkResults: { marginTop: 8, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" },
  linkResult: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
    padding: "10px 13px", background: C.panel, border: "none", borderBottom: `1px solid ${C.lineSoft}`,
    fontSize: 13.5, color: C.ink, cursor: "pointer",
  },
  modalFoot: { display: "flex", alignItems: "center", gap: 10, marginTop: 22, paddingTop: 18, borderTop: `1px solid ${C.lineSoft}` },

  // study
  studyTop: { display: "flex", alignItems: "center", gap: 16, marginBottom: 32 },
  progressTrack: { flex: 1, height: 4, background: C.line, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", background: C.accent, borderRadius: 4, transition: "width .3s ease" },
  counter: { fontSize: 12.5, color: C.faint, fontWeight: 600, whiteSpace: "nowrap" },
  stage: { display: "grid", placeItems: "center", marginBottom: 28 },
  flashcard: {
    width: "min(620px, 100%)", minHeight: 280, background: C.panel, border: `1px solid ${C.line}`,
    borderRadius: 20, padding: "40px 38px", cursor: "pointer", position: "relative",
    boxShadow: "0 10px 36px -26px rgba(31,29,26,.4)", display: "flex", flexDirection: "column", justifyContent: "center",
  },
  face: { display: "flex", flexDirection: "column", gap: 14 },
  faceTag: { fontSize: 11, fontWeight: 600, letterSpacing: ".14em", textTransform: "uppercase", color: C.faint },
  faceFront: { fontFamily: F.serif, fontSize: 27, fontWeight: 600, lineHeight: 1.25, margin: 0, color: C.ink },
  faceBack: { fontSize: 18, lineHeight: 1.55, margin: 0, color: C.ink },
  flip: { position: "absolute", bottom: 18, left: 0, right: 0, textAlign: "center", fontSize: 12, color: C.faint },
  linkedBox: { marginTop: 8, padding: "12px 14px", background: C.accentSoft, borderRadius: 11, display: "flex", flexDirection: "column", gap: 6 },
  linkedHead: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: C.accent, letterSpacing: ".02em" },
  linkedItem: { fontSize: 13.5, color: C.sub },

  revealBar: { display: "grid", placeItems: "center" },
  revealBtn: {
    display: "inline-flex", alignItems: "center", gap: 9, padding: "14px 28px",
    background: C.ink, color: C.paper, border: "none", borderRadius: 12,
    fontSize: 15, fontWeight: 600, cursor: "pointer",
  },
  grades: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 },
  gradeBtn: {
    position: "relative", display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start",
    padding: "16px 16px 14px", background: C.panel, border: `1px solid ${C.line}`,
    borderRadius: 13, cursor: "pointer", textAlign: "left",
  },
  gradeDot: { width: 9, height: 9, borderRadius: "50%", marginBottom: 4 },
  gradeLabel: { fontSize: 15, fontWeight: 600, color: C.ink },
  gradeHint: { fontSize: 12.5, color: C.faint },
  gradeNext: { fontSize: 12, color: C.sub, fontWeight: 600, marginTop: 6 },
  gradeKey: {
    position: "absolute", top: 12, right: 13, width: 19, height: 19, borderRadius: 5,
    background: C.lineSoft, color: C.faint, fontSize: 11, fontWeight: 700,
    display: "grid", placeItems: "center",
  },

  doneCard: {
    maxWidth: 460, margin: "60px auto", textAlign: "center", padding: 40,
    display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
  },
  doneMark: { width: 56, height: 56, borderRadius: "50%", background: C.accentSoft, color: C.accent, display: "grid", placeItems: "center", marginBottom: 12 },

  // graph
  legend: { display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 16 },
  legendItem: { display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: C.sub, fontWeight: 500 },
  legendDot: { width: 10, height: 10, borderRadius: "50%" },
  graphWrap: {
    position: "relative", border: `1px solid ${C.line}`, borderRadius: 16, background: C.panel,
    overflow: "hidden", minHeight: 420,
  },
  graphPanel: {
    position: "absolute", top: 16, right: 16, width: "min(300px, calc(100% - 32px))",
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18,
    boxShadow: "0 20px 50px -28px rgba(31,29,26,.5)",
  },
  panelFront: { fontFamily: F.serif, fontSize: 18, fontWeight: 600, margin: "4px 0 8px", lineHeight: 1.3 },
  panelBack: { fontSize: 14, color: C.sub, lineHeight: 1.5, margin: 0 },

  empty: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center",
    padding: "56px 24px", border: `1px dashed ${C.line}`, borderRadius: 16, background: C.panel,
  },
  emptyIcon: { width: 48, height: 48, borderRadius: 12, background: C.lineSoft, color: C.faint, display: "grid", placeItems: "center", marginBottom: 6 },
  emptyTitle: { fontFamily: F.serif, fontSize: 19, fontWeight: 600, margin: 0, color: C.ink },
  emptyBody: { fontSize: 14, color: C.sub, margin: 0, maxWidth: 320, lineHeight: 1.5 },

  // exam setup
  examForm: { display: "flex", flexDirection: "column", gap: 26, maxWidth: 600 },
  typeGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 },
  typeOpt: {
    position: "relative", textAlign: "left", display: "flex", flexDirection: "column", gap: 4,
    padding: "16px 16px 15px", border: `1px solid ${C.line}`, borderRadius: 13, background: C.panel,
  },
  typeOptOn: { borderColor: C.accent, background: C.accentSoft },
  typeCheck: {
    position: "absolute", top: 13, right: 13, width: 18, height: 18, borderRadius: 5,
    border: `1.5px solid ${C.line}`, background: C.panel, display: "grid", placeItems: "center", color: "#fff",
  },
  typeCheckOn: { background: C.accent, borderColor: C.accent },
  typeIcon: { marginBottom: 2 },
  typeName: { fontSize: 14.5, fontWeight: 600, color: C.ink },
  typeDesc: { fontSize: 12.5, color: C.sub, lineHeight: 1.4 },
  range: { width: "100%", accentColor: C.accent, cursor: "pointer", marginTop: 4 },
  rangeEnds: { display: "flex", justifyContent: "space-between", fontSize: 12, color: C.faint, marginTop: 4 },

  // exam runner
  examCard: {
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 18, padding: "30px 30px 26px",
    boxShadow: "0 10px 36px -28px rgba(31,29,26,.4)",
  },
  examPrompt: { fontFamily: F.serif, fontSize: 23, fontWeight: 600, lineHeight: 1.3, margin: "12px 0 22px", color: C.ink },
  options: { display: "flex", flexDirection: "column", gap: 10 },
  option: {
    display: "flex", alignItems: "center", gap: 13, textAlign: "left", width: "100%",
    padding: "14px 16px", border: `1px solid ${C.line}`, borderRadius: 11, background: C.panel,
    cursor: "pointer", fontSize: 15, color: C.ink,
  },
  optionCorrect: { borderColor: C.success, background: "#f1f6f1" },
  optionWrong: { borderColor: C.danger, background: "#faf0ef" },
  optMark: {
    flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: C.lineSoft, color: C.sub,
    fontSize: 13, fontWeight: 700, display: "grid", placeItems: "center",
  },
  optText: { flex: 1, lineHeight: 1.4 },
  tfStatement: {
    padding: "18px 20px", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12,
    fontSize: 16.5, lineHeight: 1.5, color: C.ink, marginBottom: 16, fontFamily: F.serif,
  },
  tfRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  tfBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 9, padding: "16px",
    border: `1px solid ${C.line}`, borderRadius: 12, background: C.panel, cursor: "pointer",
    fontSize: 15.5, fontWeight: 600, color: C.ink,
  },
  tfCorrect: { marginTop: 16, padding: "14px 16px", background: "#f1f6f1", borderRadius: 11, border: `1px solid ${C.success}` },
  nextRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginTop: 24, paddingTop: 20, borderTop: `1px solid ${C.lineSoft}` },
  verdict: { display: "flex", alignItems: "center", gap: 7, fontSize: 14.5, fontWeight: 600 },

  // open feedback
  openFb: { marginTop: 18, display: "flex", flexDirection: "column", gap: 16 },
  openModel: { padding: "14px 16px", background: C.accentSoft, borderRadius: 11 },
  kwBlock: { display: "flex", flexDirection: "column", gap: 8 },
  kwLabel: { fontSize: 12.5, fontWeight: 600, color: C.sub },
  kwBar: { height: 6, background: C.line, borderRadius: 6, overflow: "hidden" },
  kwFill: { height: "100%", borderRadius: 6, transition: "width .4s ease" },
  kwTags: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 },
  kwTag: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "3px 9px", borderRadius: 20, fontWeight: 500 },
  kwHit: { background: "#eef4ee", color: C.success },
  kwMiss: { background: C.lineSoft, color: C.faint, textDecoration: "line-through" },
  overrideRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", paddingTop: 4 },
  overrideHint: { fontSize: 12.5, color: C.faint },

  // result
  resultHero: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 6, padding: "20px 0 36px" },
  resultRing: {
    width: 96, height: 96, borderRadius: "50%", border: "3px solid", display: "grid", placeItems: "center",
    fontSize: 26, fontWeight: 700, marginBottom: 12, fontFamily: F.ui,
  },
  reviewList: { display: "flex", flexDirection: "column", gap: 10 },
  reviewItem: { display: "flex", gap: 14, padding: "16px 18px", border: `1px solid ${C.line}`, borderRadius: 12, background: C.panel },
  reviewIcon: { flexShrink: 0, marginTop: 1 },
  reviewTop: { display: "flex", alignItems: "center", gap: 9, marginBottom: 5 },
  reviewNum: { fontSize: 12, fontWeight: 700, color: C.faint },
  reviewType: { fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: C.faint },
  reviewPrompt: { fontFamily: F.serif, fontSize: 16, fontWeight: 600, margin: 0, color: C.ink, lineHeight: 1.35 },
  reviewAnswer: { fontSize: 13.5, color: C.sub, margin: "7px 0 0", lineHeight: 1.45 },

  // gamification — header chip
  streakChip: {
    display: "flex", alignItems: "center", gap: 7, padding: "7px 12px",
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 20,
    cursor: "pointer", marginRight: 4,
  },
  streakNum: { fontSize: 14, fontWeight: 700 },
  streakDivider: { width: 1, height: 14, background: C.line },
  streakGoal: { fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", minWidth: 18, justifyContent: "center" },

  // progress page
  statBand: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginBottom: 20 },
  statCard: {
    padding: "18px 18px 16px", border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel,
    display: "flex", flexDirection: "column", gap: 2,
  },
  statIcon: { width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", marginBottom: 10 },
  statValue: { fontFamily: F.serif, fontSize: 26, fontWeight: 700, color: C.ink, lineHeight: 1 },
  statLabel: { fontSize: 13, color: C.sub, fontWeight: 500, marginTop: 4 },
  statSub: { fontSize: 12, color: C.faint },

  goalPanel: {
    display: "flex", gap: 22, alignItems: "center", padding: 22,
    border: `1px solid ${C.line}`, borderRadius: 16, background: C.panel, marginBottom: 30,
  },
  goalHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 4 },
  goalTitle: { fontFamily: F.serif, fontSize: 20, fontWeight: 600, margin: 0 },
  goalDoneTag: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, color: C.success, background: C.successSoft, padding: "3px 9px", borderRadius: 20 },
  goalText: { fontSize: 14, color: C.sub, margin: "0 0 14px", lineHeight: 1.5 },
  goalSetRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  goalSetLabel: { fontSize: 12.5, color: C.faint, fontWeight: 600, marginRight: 2 },
  goalOpt: {
    minWidth: 38, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 9,
    background: C.paper, color: C.sub, fontSize: 13.5, fontWeight: 600, cursor: "pointer",
  },
  goalOptOn: { background: C.accent, color: "#fff", borderColor: C.accent },

  sectionTitle: { fontFamily: F.serif, fontSize: 22, fontWeight: 600, margin: "0 0 16px" },
  achGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 },
  achCard: {
    display: "flex", gap: 13, alignItems: "center", padding: "15px 16px",
    border: `1px solid ${C.line}`, borderRadius: 13, background: C.panel, opacity: 0.7,
  },
  achCardOn: { opacity: 1, borderColor: C.lineSoft, boxShadow: "0 6px 20px -16px rgba(31,29,26,.5)" },
  achIcon: { width: 40, height: 40, borderRadius: 10, background: C.lineSoft, color: C.faint, display: "grid", placeItems: "center", flexShrink: 0 },
  achIconOn: { background: C.warnSoft, color: C.warn },
  achName: { fontSize: 14.5, fontWeight: 600, marginBottom: 2 },
  achDesc: { fontSize: 12.5, color: C.faint, lineHeight: 1.4 },

  // toasts
  toastStack: {
    position: "fixed", right: 20, bottom: 20, zIndex: 90,
    display: "flex", flexDirection: "column", gap: 10, maxWidth: "calc(100vw - 40px)",
  },
  toast: {
    display: "flex", gap: 12, alignItems: "center", width: 300, maxWidth: "100%",
    padding: "13px 15px", background: C.panel, border: `1px solid ${C.line}`,
    borderRadius: 13, boxShadow: "0 18px 44px -20px rgba(31,29,26,.45)",
  },
  toastIcon: { width: 36, height: 36, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0 },
  toastTitle: { fontSize: 14, fontWeight: 700, color: C.ink, lineHeight: 1.2 },
  toastBody: { fontSize: 13, color: C.sub, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
};
