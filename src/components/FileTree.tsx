import React, { useState } from 'react';
import { WorkspaceFile } from '../types';
import { 
  ChevronRight, 
  ChevronDown, 
  FileCode, 
  FileText, 
  FilePlus, 
  FolderPlus, 
  RefreshCw, 
  Trash2,
  File
} from 'lucide-react';

interface FileTreeProps {
  files: WorkspaceFile[];
  activeFilePath?: string;
  onFileSelect: (filePath: string) => void;
  onRefresh: () => void;
  onCreateFile: (dirPath: string) => void;
  onCreateFolder: (dirPath: string) => void;
  onDelete: (path: string) => void;
  rootPath: string;
  width?: number;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  activeFilePath,
  onFileSelect,
  onRefresh,
  onCreateFile,
  onCreateFolder,
  onDelete,
  rootPath,
  width = 240
}) => {
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});

  const toggleDir = (dirPath: string) => {
    setExpandedDirs(prev => ({ ...prev, [dirPath]: !prev[dirPath] }));
  };

  const getFileIcon = (fileName: string) => {
    if (fileName.endsWith('.tsx') || fileName.endsWith('.ts') || fileName.endsWith('.jsx') || fileName.endsWith('.js')) {
      return <FileCode className="w-4 h-4 text-sky-400 shrink-0" />;
    }
    if (fileName.endsWith('.py')) {
      return <FileCode className="w-4 h-4 text-amber-400 shrink-0" />;
    }
    if (fileName.endsWith('.json') || fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
      return <FileText className="w-4 h-4 text-emerald-400 shrink-0" />;
    }
    if (fileName.endsWith('.md')) {
      return <FileText className="w-4 h-4 text-purple-400 shrink-0" />;
    }
    return <File className="w-4 h-4 text-zinc-400 shrink-0" />;
  };

  return (
    <div style={{ width }} className="h-full bg-[#18181b] border-r border-[#27272a] flex flex-col select-none shrink-0">
      {/* File Tree Header */}
      <div className="h-9 px-3 border-b border-[#27272a] flex items-center justify-between text-xs text-zinc-400 font-semibold tracking-wide uppercase">
        <span>Explorer</span>
        <div className="flex items-center space-x-1">
          <button
            onClick={() => onCreateFile(rootPath)}
            className="p-1 hover:text-white hover:bg-[#27272a] rounded transition"
            title="New File in Root"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onCreateFolder(rootPath)}
            className="p-1 hover:text-white hover:bg-[#27272a] rounded transition"
            title="New Folder in Root"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onRefresh}
            className="p-1 hover:text-white hover:bg-[#27272a] rounded transition"
            title="Refresh Files"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {files.length === 0 ? (
          <div className="p-4 text-center text-xs text-zinc-500">
            No files found in workspace
          </div>
        ) : (
          files.map(file => (
            <div
              key={file.path}
              className={`group flex items-center justify-between px-2 py-1.5 rounded text-xs cursor-pointer transition ${
                activeFilePath === file.path
                  ? 'bg-indigo-600/20 text-indigo-300 font-medium'
                  : 'text-zinc-300 hover:bg-[#222226] hover:text-white'
              }`}
              onClick={() => {
                if (file.isDirectory) {
                  toggleDir(file.path);
                } else {
                  onFileSelect(file.path);
                }
              }}
            >
              <div className="flex items-center space-x-2 truncate">
                {file.isDirectory ? (
                  expandedDirs[file.path] ? (
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  )
                ) : (
                  getFileIcon(file.name)
                )}
                <span className="truncate">{file.name}</span>
              </div>

              {/* Action buttons on hover */}
              <div className="hidden group-hover:flex items-center space-x-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete ${file.name}?`)) {
                      onDelete(file.path);
                    }
                  }}
                  className="p-1 text-zinc-500 hover:text-red-400 rounded"
                  title="Delete"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
