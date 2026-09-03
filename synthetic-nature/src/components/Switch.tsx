import React from 'react';
import styled from 'styled-components';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
}

const Switch: React.FC<SwitchProps> = ({ checked, onChange, id }) => {
  const inputId = id || `switch-${Math.random().toString(36).substr(2, 9)}`;

  return (
    <StyledWrapper>
      <div className="neo-toggle-container">
        <input
          className="neo-toggle-input"
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
        />
        <label className="neo-toggle" htmlFor={inputId}>
          <div className="neo-track">
            <div className="neo-background-layer" />
            <div className="neo-grid-layer" />
            <div className="neo-track-highlight" />
          </div>
          <div className="neo-thumb">
            <div className="neo-thumb-ring" />
            <div className="neo-thumb-core">
              <div className="neo-thumb-icon">
                <div className="neo-thumb-wave" />
                <div className="neo-thumb-pulse" />
              </div>
            </div>
          </div>
          <div className="neo-gesture-area" />
          <div className="neo-interaction-feedback">
            <div className="neo-ripple" />
            <div className="neo-progress-arc" />
          </div>
        </label>
      </div>
    </StyledWrapper>
  );
};

const StyledWrapper = styled.div`
  .neo-toggle-container {
    --toggle-width: 40px;
    --toggle-height: 18px;
    --toggle-bg: #181c20;
    --toggle-off-color: #475057;
    --toggle-on-color: #f4f4f4;
    --toggle-transition: 2s;
    --track-offset: 2px;
    --thumb-size: calc(var(--toggle-height) - 2 * var(--track-offset));

    position: relative;
    display: inline-flex;
    flex-direction: column;
    font-family: "Segoe UI", Tahoma, sans-serif;
    user-select: none;
  }

  .neo-toggle-input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .neo-toggle {
    position: relative;
    width: var(--toggle-width);
    height: var(--toggle-height);
    display: block;
    cursor: pointer;
    transform: translateZ(0);
    perspective: 500px;
  }

  /* Track styles */
  .neo-track {
    position: absolute;
    inset: 0;
    border-radius: calc(var(--toggle-height) / 2);
    overflow: hidden;
    transform-style: preserve-3d;
    transform: translateZ(-1px);
    transition: transform 2s;
    box-shadow:
      0 2px 10px rgba(0, 0, 0, 0.5),
      inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  }

  .neo-background-layer {
    position: absolute;
    inset: 0;
    background: var(--toggle-bg);
    background-image: linear-gradient(
      -45deg,
      rgba(20, 20, 20, 0.8) 0%,
      rgba(30, 30, 30, 0.3) 50%,
      rgba(20, 20, 20, 0.8) 100%
    );
    opacity: 1;
    transition: all var(--toggle-transition);
  }

  .neo-grid-layer {
    position: absolute;
    inset: 0;
    background-image: linear-gradient(
        to right,
        rgba(71, 80, 87, 0.05) 1px,
        transparent 1px
      ),
      linear-gradient(to bottom, rgba(71, 80, 87, 0.05) 1px, transparent 1px);
    background-size: 5px 5px;
    opacity: 0;
    transition: opacity var(--toggle-transition);
  }

  .neo-track-highlight {
    position: absolute;
    inset: var(--track-offset);
    border-radius: calc((var(--toggle-height) - 2 * var(--track-offset)) / 2);
    background: linear-gradient(90deg, transparent, rgba(54, 249, 199, 0));
    opacity: 0;
    transition: all var(--toggle-transition);
  }

  /* Thumb styles */
  .neo-thumb {
    position: absolute;
    top: 50%;
    left: var(--track-offset);
    width: var(--thumb-size);
    height: var(--thumb-size);
    border-radius: 50%;
    transform-style: preserve-3d;
    transition: left 2s, transform 2s;
    z-index: 1;
    transform: translateY(-50%);
  }

  .neo-thumb-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: var(--toggle-off-color);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    transition: background-color 2s, border-color 2s, transform 2s;
  }

  .neo-thumb-core {
    position: absolute;
    inset: 2px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), transparent);
    transition: all var(--toggle-transition);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .neo-thumb-icon {
    position: relative;
    width: 6px;
    height: 6px;
    transition: all var(--toggle-transition);
  }

  .neo-thumb-wave {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 6px;
    height: 2px;
    background: var(--toggle-off-color);
    transform: translate(-50%, -50%);
    transition: all var(--toggle-transition);
  }

  .neo-thumb-pulse {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid var(--toggle-off-color);
    transform: scale(0);
    opacity: 0;
    transition: all var(--toggle-transition);
  }

  /* Gesture area */
  .neo-gesture-area {
    position: absolute;
    inset: -10px;
    z-index: 0;
  }
  .neo-gesture-area::before,
  .neo-gesture-area::after {
    display: none !important;
  }

  /* Interaction feedback */
  .neo-interaction-feedback {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
  }
  
  .neo-ripple {
    position: absolute;
    top: 50%;
    left: 30%;
    width: 0;
    height: 0;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      var(--toggle-on-color) 0%,
      transparent 70%
    );
    transform: translate(-50%, -50%);
    opacity: 0;
    transition: all 0.4s ease-out;
  }

  .neo-progress-arc {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 80px;
    height: 80px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--toggle-on-color);
    transform: translate(-50%, -50%) scale(0) rotate(0deg);
    opacity: 0;
    transition:
      opacity 0.3s ease,
      transform 0.5s ease;
  }

  
  /* Value display */
  .neo-value-display {
    position: absolute;
    top: -22px;
    right: 0;
    font-size: 12px;
    font-weight: 500;
    color: var(--toggle-off-color);
    opacity: 0;
    transform: translateY(5px);
    transition: all var(--toggle-transition);
  }

  .neo-value-text {
    transition: all var(--toggle-transition);
  }

  /* Active states */

  /* ON state */
  .neo-toggle-input:checked + .neo-toggle .neo-thumb {
    left: calc(var(--toggle-width) - var(--thumb-size) - var(--track-offset));
  }

  .neo-toggle-input:checked + .neo-toggle .neo-thumb-ring {
    background-color: #fff;
    border-color: rgba(241, 246, 245, 0.3);
    box-shadow: 0 0 15px rgba(211, 215, 214, 0.5);
  }

  .neo-toggle-input:checked + .neo-toggle .neo-thumb-wave {
    height: 6px;
    width: 6px;
    border-radius: 50%;
    background: transparent;
    border: 1px solid #fff;
  }

  .neo-toggle-input:checked + .neo-toggle .neo-thumb-pulse {
    transform: scale(1.2);
    opacity: 0.3;
    animation: neo-pulse 1.5s infinite;
  }

  .neo-toggle-input:checked + .neo-toggle .neo-track-highlight {
    background: linear-gradient(90deg, transparent, rgba(54, 249, 199, 0.2));
    opacity: 1;
  }

  .neo-toggle-input:checked + .neo-toggle .neo-grid-layer {
    opacity: 1;
  }

  .neo-toggle-input:checked + .neo-toggle .neo-status-dot {
    background-color: var(--toggle-on-color);
    box-shadow: 0 0 8px var(--toggle-on-color);
  }

  .neo-toggle-input:checked + .neo-toggle .neo-status-text {
    color: var(--toggle-on-color);
    content: "ACTIVE";
  }

  .neo-toggle-input:checked + .neo-toggle + .neo-value-display {
    opacity: 1;
    transform: translateY(0);
  }

  .neo-toggle-input:checked + .neo-toggle + .neo-value-display .neo-value-text {
    color: var(--toggle-on-color);
  }

  /* Hover effects */
  .neo-toggle:hover .neo-thumb-ring {
    transform: scale(1.05);
  }

  .neo-toggle-input:not(:checked) + .neo-toggle:hover .neo-thumb-wave::before,
  .neo-toggle-input:not(:checked) + .neo-toggle:hover .neo-thumb-wave::after {
    opacity: 1;
  }

  /* Drag gesture handling */
  .neo-toggle.neo-dragging .neo-track {
    transform: translateZ(-1px) scale(1.02);
  }

  .neo-toggle.neo-dragging .neo-thumb {
    transition: none;
  }

  /* Animations */
  @keyframes neo-pulse {
    0% {
      transform: scale(1);
      opacity: 0.5;
    }
    50% {
      transform: scale(1.5);
      opacity: 0.2;
    }
    100% {
      transform: scale(1);
      opacity: 0.5;
    }
  }

  /* Custom script to enable advance features */
  .neo-toggle.neo-activated .neo-ripple {
    width: 100px;
    height: 100px;
    opacity: 0.5;
    transition: all 0.6s ease-out;
  }

  .neo-toggle.neo-progress .neo-progress-arc {
    opacity: 0.8;
    transform: translate(-50%, -50%) scale(1) rotate(270deg);
    transition:
      opacity 0.3s ease,
      transform 1s ease;
  }

  /* Status text change */
  .neo-toggle-input:checked + .neo-toggle .neo-status-text::before {
    content: "";
  }

  .neo-toggle-input:not(:checked) + .neo-toggle .neo-status-text::before {
    content: "";
  }
`;

export default Switch;