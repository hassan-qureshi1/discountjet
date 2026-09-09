import { NavMenu } from '@shopify/app-bridge-react';
import { Link, Route, Routes } from 'react-router-dom';
import BugSnagBoundary from './bugsnag';
import Home from './Pages/Home';
import Discounts from './Pages/Discounts';
import DiscountDetail from './Pages/DiscountDetail';
import ShopifyDiscounts from './Pages/ShopifyDiscounts';

export default function App() {
  return (
    <BugSnagBoundary>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/discounts" element={<Discounts />} />
        <Route path="/discounts/:id" element={<DiscountDetail />} />
        <Route path="/shopify-discounts" element={<ShopifyDiscounts />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <NavMenu>
        <Link to="/">Home</Link>
        <Link to="/discounts">Discounts</Link>
        <Link to="/shopify-discounts">Shopify discounts</Link>
      </NavMenu>
    </BugSnagBoundary>
  );
}
