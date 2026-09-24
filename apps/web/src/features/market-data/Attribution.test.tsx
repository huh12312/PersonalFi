// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Attribution } from '../../api/generated/types.gen.ts';
import { ProviderAttribution } from './Attribution.tsx';

const COINGECKO: Attribution = {
  provider: 'coingecko',
  required: true,
  text: 'Data provided by CoinGecko',
  linkUrl: 'https://www.coingecko.com',
  logoRequired: true,
  surfaces: ['any_price', 'settings'],
  clause:
    'CoinGecko Demo (free tier): "Attribution required even on free tier — must display ' +
    "'Data provided by CoinGecko' with logo + hyperlink\"",
  redistribution: 'permitted_with_attribution',
};

const FRED: Attribution = {
  provider: 'fred',
  required: true,
  text: 'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.',
  linkUrl: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html',
  logoRequired: false,
  surfaces: ['any_macro_figure', 'settings'],
  clause: 'FRED API terms…',
  redistribution: 'permitted_with_attribution',
};

const TIINGO: Attribution = {
  provider: 'tiingo',
  required: false,
  text: '',
  linkUrl: null,
  logoRequired: false,
  surfaces: [],
  clause: 'Tiingo forbids redistribution; no badge required.',
  redistribution: 'forbidden',
};

describe('ProviderAttribution', () => {
  it('renders the exact CoinGecko text as a hyperlink to coingecko.com', () => {
    render(<ProviderAttribution attribution={COINGECKO} />);

    const link = screen.getByRole('link', { name: /Data provided by CoinGecko/ });
    expect(link).toHaveAttribute('href', 'https://www.coingecko.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByText('Data provided by CoinGecko')).toBeInTheDocument();
  });

  it("renders FRED's exact disclaimer sentence verbatim, including the ® mark", () => {
    render(<ProviderAttribution attribution={FRED} />);

    expect(
      screen.getByText(
        'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.',
      ),
    ).toBeInTheDocument();
  });

  it('renders nothing for a provider whose licence requires no badge', () => {
    const { container } = render(<ProviderAttribution attribution={TIINGO} />);
    expect(container).toBeEmptyDOMElement();
  });
});
