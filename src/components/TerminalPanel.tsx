import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, Play, Square, Trash2, X } from 'lucide-react';

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath: string;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  isOpen,
  onClose,
  workspacePath
}) => {
  const [output, setOutput] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.electronAPI) return;

    const cleanupOut = window.electronAPI.onTerminalOutput((data: string) => {
      setOutput(prev => [...prev, data]);
    });
    const cleanupState = window.electronAPI.onTerminalState((s: { running: boolean }) => {
      setIsRunning(s.running);
    });

    return () => {
      cleanupOut();
      cleanupState();
    };
  }, []);

  // Hydrate from main-process buffer when panel opens (captures agent runs while closed)
  useEffect(() => {
    if (!isOpen || !window.electronAPI) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await window.electronAPI.getTerminalBuffer({ maxChars: 50000 });
        if (cancelled) return;
        if (snap.content && snap.content !== '(terminal is empty)') {
          setOutput([snap.content]);
        }
        setIsRunning(snap.running);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  if (!isOpen) return null;

  const handleRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim() || isRunning) return;

    const cmdToRun = command;
    setCommand('');
    setIsRunning(true);

    try {
      await window.electronAPI.executeCommand(cmdToRun, workspacePath);
    } catch (err: any) {
      setOutput(prev => [...prev, `\nError: ${err.message}\n`]);
      setIsRunning(false);
    }
  };

  const handleKill = async () => {
    await window.electronAPI.killCommand();
    setIsRunning(false);
  };

  const handleClear = async () => {
    setOutput([]);
    await window.electronAPI?.clearTerminalBuffer();
  };

  return (
    <div className="h-64 bg-[#121215] border-t border-[#27272a] flex flex-col font-mono text-xs select-none">
      {/* Terminal Title Bar */}
      <div className="h-8 bg-[#18181c] border-b border-[#27272a] px-3 flex items-center justify-between text-zinc-400">
        <div className="flex items-center space-x-2">
          <TerminalIcon className="w-3.5 h-3.5 text-indigo-400" />
          <span className="font-semibold text-zinc-300">PowerShell</span>
          {isRunning && (
            <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/20 text-amber-300 rounded animate-pulse">
              Running
            </span>
          )}
        </div>

        <div className="flex items-center space-x-2">
          {isRunning && (
            <button
              onClick={handleKill}
              className="flex items-center space-x-1 px-2 py-0.5 bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 rounded text-[10px] transition"
              title="Kill active process"
            >
              <Square className="w-2.5 h-2.5" />
              <span>Stop</span>
            </button>
          )}

          <button
            onClick={handleClear}
            className="p-1 hover:text-white hover:bg-[#27272a] rounded transition"
            title="Clear terminal"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onClose}
            className="p-1 hover:text-white hover:bg-[#27272a] rounded transition"
            title="Close Panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Output Log */}
      <div className="flex-1 p-3 overflow-y-auto whitespace-pre-wrap select-text text-zinc-300 font-mono text-[11px] leading-relaxed">
        {output.length === 0 ? (
          <span className="text-zinc-600">LocalAgents PowerShell Terminal. Ready for commands.</span>
        ) : (
          output.map((line, idx) => <span key={idx}>{line}</span>)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input Prompt */}
      <form onSubmit={handleRun} className="h-9 border-t border-[#27272a] bg-[#16161a] px-3 flex items-center space-x-2">
        <span className="text-indigo-400 font-bold">PS &gt;</span>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Run local script, git, cargo, npm, etc..."
          disabled={isRunning}
          className="flex-1 bg-transparent text-zinc-200 outline-none text-xs font-mono placeholder-zinc-600"
        />
        <button
          type="submit"
          disabled={isRunning || !command.trim()}
          className="p-1 text-zinc-400 hover:text-white disabled:opacity-30 rounded transition"
        >
          <Play className="w-3.5 h-3.5 text-emerald-400" />
        </button>
      </form>
    </div>
  );
};
