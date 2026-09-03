'use client';

import React from 'react';
import styled from 'styled-components';

interface ProviderActionButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  fullWidth?: boolean;
}

const StyledWrapper = styled.div<{ $fullWidth?: boolean }>`
  .button {
    min-width: 120px;
    ${props => props.$fullWidth ? 'width: 100%;' : ''}

    position: relative;
    cursor: pointer;

    padding: 12px 17px;
    border: 0;
    border-radius: 7px;

    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
    background: radial-gradient(
      ellipse at bottom,
      rgba(71, 81, 92, 1) 0%,
      rgba(11, 21, 30, 1) 45%
    );

    color: rgba(255, 255, 255, 0.66);
    font-family: 'Space Grotesk', monospace;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;

    transition: all 1s cubic-bezier(0.15, 0.83, 0.66, 1);

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }
  }

  .button::before {
    content: "";
    width: 70%;
    height: 1px;

    position: absolute;
    bottom: 0;
    left: 15%;

    background: rgb(255, 255, 255);
    background: linear-gradient(
      90deg,
      rgba(255, 255, 255, 0) 0%,
      rgba(255, 255, 255, 1) 50%,
      rgba(255, 255, 255, 0) 100%
    );
    opacity: 0.2;

    transition: all 1s cubic-bezier(0.15, 0.83, 0.66, 1);
  }

  .button:hover:not(:disabled) {
    color: rgba(255, 255, 255, 1);
    transform: scale(1.05) translateY(-2px);
  }

  .button:hover:not(:disabled)::before {
    opacity: 1;
  }

  .button:active:not(:disabled) {
    transform: scale(0.98) translateY(0);
  }
`;

export function ProviderActionButton({
  children,
  onClick,
  disabled = false,
  fullWidth = false
}: ProviderActionButtonProps) {
  return (
    <StyledWrapper $fullWidth={fullWidth}>
      <button 
        className="button"
        onClick={onClick}
        disabled={disabled}
        type="button"
      >
        {children}
      </button>
    </StyledWrapper>
  );
}

export default ProviderActionButton;