import React from 'react';
import { createRoot } from 'react-dom/client';
import { Checkout } from './App.js';
import './checkout.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Checkout />
  </React.StrictMode>,
);
