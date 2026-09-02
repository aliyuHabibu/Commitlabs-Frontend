import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import CommitmentDetailHeader from '../Commitmentdetailheader';

const validContractId = `C${'B'.repeat(55)}`;

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof CommitmentDetailHeader>> = {},
) {
  const props = {
    commitmentId: validContractId,
    statusLabel: 'Active',
    statusVariant: 'active',
    onBack: vi.fn(),
    onShare: vi.fn(),
    ...overrides,
  };
  const view = render(<CommitmentDetailHeader {...props} />);
  return { props, ...view };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('CommitmentDetailHeader', () => {
  it('renders the commitment id and status pill', () => {
    renderHeader({ statusLabel: 'Settled', statusVariant: 'settled' });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(validContractId);
    expect(screen.getByText('Settled')).toBeInTheDocument();
  });

  it('calls onBack when the back button is clicked', () => {
    const { props } = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Go back to My Commitments' }));

    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onShare when the share button is clicked', async () => {
    const { props } = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Share commitment' }));

    await waitFor(() => expect(props.onShare).toHaveBeenCalledTimes(1));
  });

  it('copies the commitment id and surfaces a live region status', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Copy commitment ID' }));

    await waitFor(() =>
      expect(within(screen.getByRole('status')).getByText('Copied')).toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('exposes an accessible explorer link with anti-tabnabbing attributes', () => {
    renderHeader();

    const link = screen.getByRole('link', { name: 'Open commitment in Stellar explorer' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('href', expect.stringContaining(validContractId));
  });

  it('renders a copy button and status live region', () => {
    renderHeader();

    expect(screen.getByRole('button', { name: 'Copy commitment ID' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('supports keyboard activation of the copy button', async () => {
    const user = userEvent.setup();
    renderHeader();

    const copyButton = screen.getByRole('button', { name: 'Copy commitment ID' });
    copyButton.focus();
    expect(copyButton).toHaveFocus();

    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(within(screen.getByRole('status')).getByText('Copied')).toBeInTheDocument(),
    );
  });
});
