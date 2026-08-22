import { Navigate, Route, Routes } from 'react-router-dom';
import { AppFrame } from './components/layout/AppFrame';
import Overview from './pages/Overview';
import Templates from './pages/Templates';
import CreatePromotion from './pages/CreatePromotion';
import Campaigns from './pages/Campaigns';
import CampaignTemplates from './pages/CampaignTemplates';
import CampaignBuilder from './pages/CampaignBuilder';
import CampaignDetail from './pages/CampaignDetail';
import Discounts from './pages/Discounts';
import DiscountDetail from './pages/DiscountDetail';
import DiscountSetup from './pages/DiscountSetup';
import UpsellDesigner from './pages/UpsellDesigner';
import CartTransformation from './pages/CartTransformation';
import CartTransformEditor from './pages/CartTransformEditor';
import PlanAndLimits from './pages/PlanAndLimits';

export default function App() {
  return (
    <AppFrame>
      <Routes>
        <Route path="/" element={<Overview />} />

        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/:id/create" element={<CreatePromotion />} />

        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/campaigns/templates" element={<CampaignTemplates />} />
        <Route path="/campaigns/new" element={<CampaignBuilder />} />
        <Route path="/campaigns/:id/edit" element={<CampaignBuilder />} />
        <Route path="/campaigns/:id" element={<CampaignDetail />} />

        <Route path="/discounts" element={<Discounts />} />
        <Route path="/discounts/new" element={<DiscountSetup />} />
        <Route path="/discounts/:id" element={<DiscountDetail />} />
        <Route path="/discounts/:id/upsell" element={<UpsellDesigner />} />

        <Route path="/cart-transforms" element={<CartTransformation />} />
        <Route path="/cart-transforms/new" element={<CartTransformEditor />} />
        <Route path="/cart-transforms/:id/edit" element={<CartTransformEditor />} />

        <Route path="/plan" element={<PlanAndLimits />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppFrame>
  );
}
