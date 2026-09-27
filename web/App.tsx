import { NavMenu } from '@shopify/app-bridge-react';
import {
  Link, Route, Routes, useParams,
} from 'react-router-dom';
import BugSnagBoundary from './bugsnag';
import Home from './Pages/Home';
import Discounts from './Pages/Discounts';
import DiscountDetail from './Pages/DiscountDetail';
import Bundles from './Pages/Bundles';
import BundleEditor from './Pages/BundleEditor';
import Templates from './Pages/Templates';
import TemplateCreate from './Pages/TemplateCreate';
import Campaigns from './Pages/Campaigns';
import CampaignBuilder from './Pages/CampaignBuilder';
import CampaignDetail from './Pages/CampaignDetail';

/**
 * React Router v6 does NOT remount a route's `element` when only the `:id`
 * param changes while the same route still matches — it re-renders the same
 * component instance with a new `campaign` prop. Browser back/forward between
 * two different campaigns' edit (or detail) URLs hits exactly this, with no
 * list visit in between to force a remount.
 *
 * That matters here specifically because `CampaignBuilder`'s descendants
 * (`ScheduleStep`) lazily seed local state from `campaign` via `useState`
 * initialisers that only ever run once per component instance (deliberately —
 * see that file). Reusing the instance across campaigns would leave campaign
 * A's schedule fields in state while every save call targets `campaign.id`,
 * which is now B — silently writing A's window onto B's row on the very next
 * edit, or on the unmount flush. Keying the element by the id param forces
 * React to tear down and remount the whole subtree on every campaign switch,
 * so every descendant's local state (lazily seeded or otherwise) starts fresh
 * against the right campaign. The cost — in-flight local UI state for the
 * campaign being left doesn't survive the switch — is correct here: that
 * state belongs to the OTHER campaign.
 */
function CampaignBuilderRoute() {
  const { id } = useParams();
  return <CampaignBuilder key={id} />;
}

function CampaignDetailRoute() {
  const { id } = useParams();
  return <CampaignDetail key={id} />;
}

export default function App() {
  return (
    <BugSnagBoundary>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/discounts" element={<Discounts />} />
        <Route path="/discounts/:id" element={<DiscountDetail />} />
        <Route path="/bundles" element={<Bundles />} />
        <Route path="/bundles/new" element={<BundleEditor />} />
        <Route path="/bundles/:id/edit" element={<BundleEditor />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/:slug" element={<TemplateCreate />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/campaigns/:id/edit" element={<CampaignBuilderRoute />} />
        <Route path="/campaigns/:id" element={<CampaignDetailRoute />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <NavMenu>
        <Link to="/">Home</Link>
        <Link to="/discounts">Discounts</Link>
        <Link to="/bundles">Bundles</Link>
        <Link to="/templates">Templates</Link>
        <Link to="/campaigns">Campaigns</Link>
      </NavMenu>
    </BugSnagBoundary>
  );
}
