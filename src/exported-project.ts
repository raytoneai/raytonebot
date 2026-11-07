import { createProviderConnection, providerCatalog, type AgentFrontendProject } from "./schema/agentuxConfig.ts";

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
    "connections": providerCatalog.map(({ id }) => {
      const provider = createProviderConnection(id, id === "deepseek");
      return id === "deepseek" ? {
        ...provider,
        baseUrl: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-flash",
        models: ["deepseek-flash", "deepseek-v4-pro"],
      } : provider;
    })
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
    "mainSize": 56,
    "rightPanelSize": 44,
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
    "speakerLabels": false,
    "userAvatar": false,
    "agentAvatar": true,
    "messageActions": {
      "copy": false,
      "regenerate": false,
      "edit": false,
      "userCopy": true,
      "userEdit": true,
      "userTime": false,
      "agentCopy": true,
      "agentRegenerate": true,
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
    "timelineRail": false,
    "foldWhenDone": true
  },
  "reasoning": {
    "show": "summary",
    "collapse": "summary-first",
    "expandable": true,
    "whenDone": "hide"
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
