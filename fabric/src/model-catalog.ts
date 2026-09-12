// Intended hackathon roles; availability is always derived from live node snapshots.
export const PRIMARY_MODELS = [
  {
    id: 'qwen3-0.6b', name: 'Qwen3 0.6B', parameters: '0.6B', role: 'Intent routing',
    capabilities: ['routing', 'classify'],
    source_url: 'https://huggingface.co/Qwen/Qwen3-0.6B',
  },
  {
    id: 'qwen2.5-coder-1.5b', name: 'Qwen2.5 Coder 1.5B', parameters: '1.5B', role: 'Code analysis',
    capabilities: ['code_analysis'],
    source_url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct',
  },
  {
    id: 'smollm2-1.7b', name: 'SmolLM2 1.7B', parameters: '1.7B', role: 'Summarization',
    capabilities: ['summarize'],
    source_url: 'https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct',
  },
  {
    id: 'qwen2.5-0.5b', name: 'Qwen2.5 0.5B', parameters: '0.5B', role: 'Structured extraction',
    capabilities: ['extract'],
    source_url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct',
  },
  {
    id: 'qwen3-1.7b', name: 'Qwen3 1.7B', parameters: '1.7B', role: 'Reasoning & judging',
    capabilities: ['reasoning', 'judge', 'complete'],
    source_url: 'https://huggingface.co/Qwen/Qwen3-1.7B',
  },
] as const;
