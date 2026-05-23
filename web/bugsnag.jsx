import Bugsnag from '@bugsnag/js';
import BugsnagPluginReact from '@bugsnag/plugin-react';
import React from 'react';

const apiKey = typeof import.meta.env !== 'undefined' ? import.meta.env.VITE_BUGSNAG_API_KEY : undefined;

if (apiKey) {
  try {
    Bugsnag.start({
      apiKey,
      plugins: [new BugsnagPluginReact()],
      releaseStage: typeof import.meta.env !== 'undefined' ? import.meta.env.VITE_APP_ENV : 'production',
      autoTrackSessions: true,
      appType: 'Frontend',
    });
  } catch {
    // silently fail if Bugsnag can't start
  }
}

const BugSnagBoundary = Bugsnag.getPlugin('react')?.createErrorBoundary(React) ?? React.Fragment;

export default BugSnagBoundary;

export const options = { triggers: { api: true } };
