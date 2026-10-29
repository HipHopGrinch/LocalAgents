import React, { useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { OpenTab } from '../types';
import { X, Save, FileCode } from 'lucide-react';

interface EditorViewProps {
  tabs: OpenTab[];
  activeTabPath?: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onContentChange: (path: string, newContent: string) => void;
  onSaveTab: (path: string) => void;
}

export const EditorView: React.FC<EditorViewProps> = ({
  tabs,
  activeTabPath,
  onSelectTab,
  onCloseTab,
  onContentChange,
  onSaveTab
}) => {
  const activeTab = tabs.find(t => t.path === activeTabPath);

  // Global Ctrl+S handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (activeTabPath) {
          onSaveTab(activeTabPath);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTabPath, onSaveTab]);

  return (
    <div className="flex-1 h-full flex flex-col bg-[#1e1e24] overflow-hidden">
      {/* Tabs Header */}
      <div className="h-9 bg-[#141418] border-b border-[#27272a] flex items-center overflow-x-auto select-none no-scrollbar">
        {tabs.map(tab => {
          const isActive = tab.path === activeTabPath;
          return (
            <div
              key={tab.path}
              onClick={() => onSelectTab(tab.path)}
              className={`group h-full px-3 flex items-center space-x-2 border-r border-[#27272a] text-xs cursor-pointer transition select-none ${
                isActive
                  ? 'bg-[#1e1e24] text-zinc-100 border-t-2 border-t-indigo-500 font-medium'
                  : 'bg-[#141418] text-zinc-400 hover:bg-[#18181d] hover:text-zinc-200'
              }`}
            >
              <FileCode className="w-3.5 h-3.5 text-zinc-400" />
              <span className="truncate max-w-[140px]">{tab.name}</span>
              
              {/* Dirty indicator or Close button */}
              <div className="flex items-center">
                {tab.isDirty && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 group-hover:hidden mr-1" />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.path);
                  }}
                  className={`p-0.5 rounded hover:bg-[#33333d] hover:text-white ${
                    tab.isDirty ? 'hidden group-hover:block' : ''
                  }`}
                  title="Close (Ctrl+W)"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}

        {tabs.length > 0 && activeTab?.isDirty && (
          <button
            onClick={() => activeTabPath && onSaveTab(activeTabPath)}
            className="ml-auto mr-3 flex items-center space-x-1.5 px-2 py-0.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded transition shadow-sm"
          >
            <Save className="w-3 h-3" />
            <span>Save</span>
          </button>
        )}
      </div>

      {/* Editor Body */}
      <div className="flex-1 relative">
        {activeTab ? (
          <Editor
            height="100%"
            language={activeTab.language}
            theme="vs-dark"
            value={activeTab.content}
            onChange={(value) => onContentChange(activeTab.path, value || '')}
            options={{
              fontSize: 13,
              fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
              fontLigatures: true,
              minimap: { enabled: true, maxColumn: 80 },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              lineNumbers: 'on',
              renderWhitespace: 'selection',
              smoothScrolling: true,
              cursorBlinking: 'smooth'
            }}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500 select-none">
            <div className="text-4xl mb-3">⚡</div>
            <p className="text-sm font-medium text-zinc-400">No file open</p>
            <p className="text-xs text-zinc-600 mt-1">Select a file from the explorer or invoke an agent prompt</p>
          </div>
        )}
      </div>
    </div>
  );
};
