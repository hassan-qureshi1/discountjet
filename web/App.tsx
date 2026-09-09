import { NavMenu } from '@shopify/app-bridge-react';
import { Link, Route, Routes } from 'react-router-dom';
import BugSnagBoundary from './bugsnag';
import Home from './Pages/Home';
import Discounts from './Pages/Discounts';

export default function App() {
  return (
    <BugSnagBoundary>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/discounts" element={<Discounts />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <NavMenu>
        <Link to="/">Home</Link>
        <Link to="/discounts">Discounts</Link>
      </NavMenu>
    </BugSnagBoundary>
  );
}
