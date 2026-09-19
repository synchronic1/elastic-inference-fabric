import { useState, useSyncExternalStore } from 'react';
import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';

function subscribeTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export default function LocalCopilot() {
  const [error, setError] = useState('');
  const dark = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme !== 'light', () => true);
  return <div className={dark ? 'dark' : ''}>
    {error && <p className="fabric-chat-error" role="alert">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></p>}
    <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId="fabric" credentials="include"
      useSingleEndpoint enableInspector={false} showDevConsole={false}
      onError={({ error }) => setError(error.message)}>
      <CopilotChat agentId="fabric" className="fabric-local-chat" inspectorTools={false}
        labels={{ welcomeMessageText: 'Ask a resident model a question. You can follow up in this conversation.' }}
        input={{ toolsMenu: [], showDisclaimer: false }}
        messageView={{
          cursor: () => <p className="fabric-chat-progress" role="status">A local model is generating a response…</p>,
          assistantMessage: {
            markdownRenderer: ({ content }) => <pre className="fabric-assistant-text">{content}</pre>,
          },
        }} />
    </CopilotKitProvider>
  </div>;
}
