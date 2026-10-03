import type { AgentFrontendProject } from "./schema/agentuxConfig";

// Snapshot of what was composed in AgentCanvas. Edit by hand to tweak the export.
export const project = {
  "id": "raytonebot-local",
  "name": "RaytoneBot",
  "product": {
    "surface": {
      "mode": "agentcanvas"
    },
    "brand": {
      "displayName": "RaytoneBot",
      "mark": {
        "kind": "builtin",
        "id": "sparkles"
      },
      "accent": {
        "kind": "theme"
      },
      "corners": "theme",
      "showPoweredBy": true
    },
    "welcome": {
      "headline": "今天想完成什么？",
      "supportingText": "描述任务，查看执行过程，确认操作，并检查产物。",
      "suggestedPrompts": [
        "只读检查当前工作目录，告诉我有哪些文件。",
        "先给出执行计划，等我确认后再创建一份 Markdown 笔记。",
        "阅读 README，概括这个项目目前具备的能力。"
      ],
      "showSuggestedPrompts": true
    },
    "design": {},
    "extensions": {
      "stylesheets": []
    }
  },
  "template": "coding",
  "runtime": {
    "transport": "replay",
    "harness": "agentux"
  },
  "providers": {
    "defaultProviderId": "deepseek",
    "settingsLauncher": true,
    "connections": [
      {
        "id": "openai",
        "kind": "builtin",
        "label": "OpenAI",
        "description": "Default GPT-family hosted provider for general coding agents.",
        "protocol": "openai-compatible",
        "baseUrl": "https://api.openai.com/v1",
        "auth": {
          "mode": "env",
          "envVar": "OPENAI_API_KEY"
        },
        "defaultModel": "gpt-4o",
        "models": [
          "gpt-4o",
          "gpt-4o-mini"
        ],
        "enabled": false
      },
      {
        "id": "anthropic",
        "kind": "builtin",
        "label": "Anthropic",
        "description": "Claude-family provider for long-context coding and review workflows.",
        "protocol": "anthropic",
        "baseUrl": "https://api.anthropic.com/v1",
        "auth": {
          "mode": "env",
          "envVar": "ANTHROPIC_API_KEY"
        },
        "defaultModel": "claude-sonnet-4",
        "models": [
          "claude-sonnet-4",
          "claude-haiku"
        ],
        "enabled": false
      },
      {
        "id": "gemini",
        "kind": "builtin",
        "label": "Gemini",
        "description": "Google Gemini provider for multimodal and broad-context agent flows.",
        "protocol": "openai-compatible",
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "auth": {
          "mode": "env",
          "envVar": "GEMINI_API_KEY"
        },
        "defaultModel": "gemini-2.5-pro",
        "models": [
          "gemini-2.5-pro",
          "gemini-2.5-flash"
        ],
        "enabled": false
      },
      {
        "id": "openrouter",
        "kind": "builtin",
        "label": "OpenRouter",
        "description": "Router provider for switching across hosted model families.",
        "protocol": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api/v1",
        "auth": {
          "mode": "env",
          "envVar": "OPENROUTER_API_KEY"
        },
        "defaultModel": "anthropic/claude-sonnet-4",
        "models": [
          "anthropic/claude-sonnet-4",
          "openai/gpt-4o"
        ],
        "enabled": false
      },
      {
        "id": "deepseek",
        "kind": "builtin",
        "label": "DeepSeek",
        "description": "DeepSeek chat and reasoning provider presets.",
        "protocol": "openai-compatible",
        "baseUrl": "https://api.deepseek.com/v1",
        "auth": {
          "mode": "env",
          "envVar": "DEEPSEEK_API_KEY"
        },
        "defaultModel": "deepseek-flash",
        "models": [
          "deepseek-flash",
          "deepseek-v4-pro"
        ],
        "enabled": true
      },
      {
        "id": "z-ai",
        "kind": "builtin",
        "label": "Z.ai",
        "description": "GLM-family provider presets for Z.ai compatible adapters.",
        "protocol": "openai-compatible",
        "baseUrl": "https://api.z.ai/api/paas/v4/",
        "auth": {
          "mode": "env",
          "envVar": "ZAI_API_KEY"
        },
        "defaultModel": "glm-5.1",
        "models": [
          "glm-5.1",
          "glm-4.5",
          "glm-4.5-air"
        ],
        "enabled": false
      },
      {
        "id": "moonshot",
        "kind": "builtin",
        "label": "MoonShot",
        "description": "Kimi and Moonshot provider presets for Chinese and long-context agents.",
        "protocol": "openai-compatible",
        "baseUrl": "https://api.moonshot.cn/v1",
        "auth": {
          "mode": "env",
          "envVar": "MOONSHOT_API_KEY"
        },
        "defaultModel": "kimi-k2",
        "models": [
          "kimi-k2",
          "moonshot-v1-128k"
        ],
        "enabled": false
      },
      {
        "id": "local",
        "kind": "builtin",
        "label": "Local models",
        "description": "OpenAI-compatible local runtime presets for Ollama, LM Studio, and similar tools.",
        "protocol": "openai-compatible",
        "baseUrl": "http://localhost:11434/v1",
        "auth": {
          "mode": "none"
        },
        "defaultModel": "ollama/qwen3-coder",
        "models": [
          "ollama/qwen3-coder",
          "lmstudio/local-model",
          "local-model"
        ],
        "enabled": false
      },
      {
        "id": "custom-provider",
        "kind": "custom",
        "label": "Custom provider",
        "description": "Bring any OpenAI-compatible gateway, private endpoint, or hosted model proxy.",
        "protocol": "openai-compatible",
        "baseUrl": "https://api.example.com/v1",
        "auth": {
          "mode": "env",
          "envVar": "CUSTOM_PROVIDER_API_KEY"
        },
        "defaultModel": "custom-model",
        "models": [
          "custom-model"
        ],
        "enabled": false
      }
    ]
  },
  "layout": {
    "regions": [
      "sidebar",
      "main",
      "composer",
      "right-panel",
      "bottom-dock",
      "overlay"
    ],
    "mainSize": 68,
    "rightPanelSize": 32,
    "bottomDockSize": 28,
    "slots": [
      {
        "id": "sessions",
        "region": "sidebar",
        "component": "SessionSidebar",
        "enabled": true
      },
      {
        "id": "chat",
        "region": "main",
        "component": "ChatFrame",
        "enabled": true
      },
      {
        "id": "composer",
        "region": "composer",
        "component": "ComposerFrame",
        "enabled": true
      },
      {
        "id": "output",
        "region": "right-panel",
        "component": "OutputFrame",
        "enabled": true
      },
      {
        "id": "capabilities",
        "region": "bottom-dock",
        "component": "CapabilityTray",
        "enabled": false
      },
      {
        "id": "git",
        "region": "right-panel",
        "component": "GitFrame",
        "enabled": false
      },
      {
        "id": "debug",
        "region": "bottom-dock",
        "component": "DebugDock",
        "enabled": false
      }
    ]
  },
  "theme": {
    "preset": "soft-glass",
    "stylePreset": "native",
    "density": "compact",
    "radius": 8,
    "motion": {
      "reasoning": "wave",
      "writing": "smooth-stream",
      "toolCall": "card",
      "writingParams": {
        "streamWps": 40,
        "typeCps": 24,
        "chunkSize": 4,
        "chunkIntervalMs": 220
      }
    }
  },
  "composer": {
    "fileUpload": true,
    "mic": false,
    "thinkingBudget": true,
    "modelSwitcher": false,
    "toolToggle": true,
    "promptShortcuts": false
  },
  "conversation": {
    "speakerLabels": true,
    "userAvatar": true,
    "agentAvatar": true,
    "messageActions": {
      "copy": false,
      "regenerate": false,
      "edit": false,
      "userCopy": false,
      "userEdit": false,
      "userTime": false,
      "agentCopy": false,
      "agentRegenerate": false,
      "agentEdit": false,
      "agentTime": false
    },
    "emptyState": "minimal"
  },
  "sidebar": {
    "newButton": false,
    "search": true,
    "grouping": true,
    "footer": true
  },
  "welcome": {
    "greeting": "你好，我是 RaytoneBot"
  },
  "context": {
    "attachmentChips": true
  },
  "toolCalls": {
    "detail": "full",
    "progress": "status-icon",
    "approval": "inline",
    "timelineRail": false
  },
  "reasoning": {
    "show": "summary",
    "collapse": "summary-first",
    "expandable": true
  },
  "blocks": {
    "codeDiff": true,
    "errorCollapse": false,
    "toolLogTail": false
  },
  "output": {
    "source": "artifact",
    "artifactRenderer": "auto",
    "surface": "right-panel",
    "supportedArtifactRenderers": [
      "code",
      "diff",
      "markdown",
      "preview",
      "data"
    ]
  },
  "mediaGeneration": {
    "imageStyle": "grid",
    "audioStyle": "waveform",
    "videoStyle": "storyboard"
  },
  "git": {
    "showBranchStatus": true,
    "showChangedFiles": true,
    "showDiff": true,
    "suggestCommitMessage": true,
    "allowCommit": true,
    "allowPush": false
  },
  "export": {
    "target": "vite-react",
    "includeFixtures": true,
    "includeHarnessAdapter": true
  }
} as unknown as AgentFrontendProject;

export default project;
