import { NavMenu } from '@shopify/app-bridge-react';
import { Link, Route, Routes } from 'react-router-dom';
import BugSnagBoundary from './bugsnag';
import Home from './Pages/Home';
import Discounts from './Pages/Discounts';
import DiscountDetail from './Pages/DiscountDetail';
import Bundles from './Pages/Bundles';
import BundleEditor from './Pages/BundleEditor';
import Templates from './Pages/Templates';
import TemplateCreate from './Pages/TemplateCreate';

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
        <Route path="*" element={<Home />} />
      </Routes>
      <NavMenu>
        <Link to="/">Home</Link>
        <Link to="/discounts">Discounts</Link>
        <Link to="/bundles">Bundles</Link>
        <Link to="/templates">Templates</Link>
      </NavMenu>
    </BugSnagBoundary>
  );
}
