"use client";

import { useEffect, useRef, useState } from "react";
import {
  defaultSettings,
  formatOracleSql,
  sanitizeSettings,
  type ExpressionWidth,
  type FormatterSettings,
  type ItemsPerLine,
} from "@/lib/formatSql";
const SETTINGS_KEY = "query-align.settings.v3";
const SOURCE_KEY = "query-align.source.v1";

type Message = {
  tone: "idle" | "ok" | "error";
  text: string;
};

export default function Workbench() {
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState("");
  const [output, setOutput] = useState("");
  const [settings, setSettings] = useState<FormatterSettings>(defaultSettings);
  const [message, setMessage] = useState<Message>({
    tone: "idle",
    text: "쿼리를 넣으면 바로 정렬됩니다.",
  });
  const [copied, setCopied] = useState(false);

  const sourceRef = useRef(source);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<number | null>(null);
  const skipSettings = useRef(true);

  sourceRef.current = source;

  const formatRef = useRef<(sql: string, current: FormatterSettings) => void>(() => {});
  formatRef.current = (sql, current) => {
    if (!sql.trim()) {
      setOutput("");
      setMessage({ tone: "idle", text: "정렬할 쿼리를 입력하세요." });
      return;
    }

    try {
      const next = formatOracleSql(sql, current);
      setOutput(next);
      const lines = next.split("\n").length;
      setMessage({ tone: "ok", text: `${lines}줄로 정렬했습니다.` });
    } catch (error) {
      const text = error instanceof Error ? error.message : "정렬하지 못했습니다.";
      setMessage({ tone: "error", text });
    }
  };

  useEffect(() => {
    const loadedSettings = readSettings();
    const loadedSource = readSource();
    setSettings(loadedSettings);
    setSource(loadedSource);
    if (loadedSource.trim()) formatRef.current(loadedSource, loadedSettings);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (skipSettings.current) {
      skipSettings.current = false;
      return;
    }
    const current = sourceRef.current;
    if (current.trim()) formatRef.current(current, settings);
  }, [settings, ready]);

  useEffect(() => {
    if (!ready) return;
    persist(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings, ready]);

  useEffect(() => {
    if (!ready) return;
    persist(SOURCE_KEY, source);
  }, [source, ready]);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  function updateSettings(patch: Partial<FormatterSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!pasted) return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart ?? source.length;
    const end = target.selectionEnd ?? source.length;
    const next = source.slice(0, start) + pasted + source.slice(end);
    setSource(next);
    formatRef.current(next, settings);
  }

  function clearAll() {
    setSource("");
    setOutput("");
    setMessage({ tone: "idle", text: "쿼리를 넣으면 바로 정렬됩니다." });
  }

  async function copyOutput() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
    } catch {
      const area = outputRef.current;
      if (!area) return;
      area.focus();
      area.select();
      document.execCommand("copy");
    }
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  const sourceCount = source.trim() ? `${source.split("\n").length}줄` : "비어 있음";
  const outputCount = output.trim() ? `${output.split("\n").length}줄` : "아직 없음";

  return (
    <main className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <h1>쿼리 정렬</h1>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={copyOutput} disabled={!output}>
            {copied ? "복사됨" : "복사"}
          </button>
          <button className="btn" type="button" onClick={clearAll} disabled={!source && !output}>
            비우기
          </button>
        </div>
      </header>

      <section className="settings" aria-label="정렬 옵션">
        <Segmented
          name="letterCase"
          legend="대소문자"
          value={settings.letterCase}
          options={[
            { value: "preserve", label: "그대로" },
            { value: "upper", label: "대문자" },
            { value: "lower", label: "소문자" },
          ]}
          onChange={(letterCase) => updateSettings({ letterCase })}
        />
        <ItemCount
          name="selectItemsPerLine"
          legend="SELECT"
          value={settings.selectItemsPerLine}
          onChange={(selectItemsPerLine) => updateSettings({ selectItemsPerLine })}
        />
        <ItemCount
          name="clauseItemsPerLine"
          legend="GROUP BY / ORDER BY"
          value={settings.clauseItemsPerLine}
          onChange={(clauseItemsPerLine) => updateSettings({ clauseItemsPerLine })}
        />
        <Segmented
          name="tabWidth"
          legend="간격"
          value={String(settings.tabWidth)}
          options={[
            { value: "0", label: "0" },
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "4", label: "4" },
          ]}
          onChange={(value) => {
            const width = Number(value);
            if (width === 0 || width === 1 || width === 2 || width === 4) {
              updateSettings({ tabWidth: width });
            }
          }}
        />
        <Segmented
          name="expressionWidth"
          legend="줄 길이"
          value={String(settings.expressionWidth)}
          options={[
            { value: "10", label: "10" },
            { value: "50", label: "50" },
            { value: "80", label: "80" },
            { value: "120", label: "120" },
          ]}
          onChange={(value) => updateSettings({ expressionWidth: Number(value) as ExpressionWidth })}
        />
        <button className="reset" type="button" onClick={() => setSettings({ ...defaultSettings })}>
          기본값
        </button>
      </section>

      <section className="editors">
        <div className="pane">
          <div className="pane-head">
            <strong>원본</strong>
            <span>{sourceCount}</span>
          </div>
          <textarea
            aria-label="원본 쿼리"
            value={source}
            placeholder="여기에 오라클 쿼리를 붙여 넣으세요."
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            wrap="off"
            style={{ tabSize: settings.tabWidth }}
            onChange={(event) => {
              const next = event.target.value;
              setSource(next);
              formatRef.current(next, settings);
            }}
            onPaste={onPaste}
          />
        </div>
        <div className="pane result">
          <div className="pane-head">
            <strong>정렬 결과</strong>
            <span>{outputCount}</span>
          </div>
          <textarea
            ref={outputRef}
            aria-label="정렬 결과"
            value={output}
            readOnly
            placeholder="정렬된 쿼리가 여기에 표시됩니다."
            spellCheck={false}
            wrap="off"
            style={{ tabSize: settings.tabWidth }}
          />
        </div>
      </section>

      <footer className="status">
        <p className={`message ${message.tone}`} role="status">
          {message.text}
        </p>
      </footer>
    </main>
  );
}

function ItemCount({
  name,
  legend,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  value: ItemsPerLine;
  onChange: (value: ItemsPerLine) => void;
}) {
  const options = [1, 2, 3, 5, 10].map((count) => ({
    value: String(count),
    label: `${count}개`,
  }));

  return (
    <Segmented
      name={name}
      legend={legend}
      value={String(value)}
      options={options}
      onChange={(next) => onChange(Number(next) as ItemsPerLine)}
    />
  );
}

function Segmented<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="segment">
        {options.map((option) => (
          <label key={option.value} className={value === option.value ? "on" : ""}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function readSettings(): FormatterSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...defaultSettings };
  }
}

function readSource(): string {
  try {
    return localStorage.getItem(SOURCE_KEY) ?? "";
  } catch {
    return "";
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장 공간이 가득 차도 정렬 자체는 계속된다.
  }
}
