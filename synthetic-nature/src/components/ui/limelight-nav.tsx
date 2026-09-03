import React, { useState, useRef, useLayoutEffect, cloneElement } from 'react';

// --- Internal Types and Defaults ---

const DefaultHomeIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
const DefaultCompassIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" /></svg>;
const DefaultBellIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>;

export type NavItem = {
  id: string | number;
  icon: React.ReactElement;
  label?: string;
  onClick?: () => void;
};

const defaultNavItems: NavItem[] = [
  { id: 'default-home', icon: <DefaultHomeIcon />, label: 'Home' },
  { id: 'default-explore', icon: <DefaultCompassIcon />, label: 'Explore' },
  { id: 'default-notifications', icon: <DefaultBellIcon />, label: 'Notifications' },
];

type LimelightNavProps = {
  items?: NavItem[];
  defaultActiveIndex?: number;
  onTabChange?: (index: number) => void;
  className?: string;
  limelightClassName?: string;
  iconContainerClassName?: string;
  iconClassName?: string;
  /** Accent color for the limelight glow — defaults to ENZO green (#4ade80) */
  accentColor?: string;
};

/**
 * An adaptive-width navigation bar with a "limelight" effect that highlights the active item.
 * Themed to match ENZO's cyberpunk DedSec aesthetic.
 */
export const LimelightNav = ({
  items = defaultNavItems,
  defaultActiveIndex = 0,
  onTabChange,
  className,
  limelightClassName,
  iconContainerClassName,
  iconClassName,
  accentColor = '#4ade80',
}: LimelightNavProps) => {
  const [activeIndex, setActiveIndex] = useState(defaultActiveIndex);
  const [isReady, setIsReady] = useState(false);
  const navItemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const limelightRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (items.length === 0) return;

    const limelight = limelightRef.current;
    const activeItem = navItemRefs.current[activeIndex];

    if (limelight && activeItem) {
      const newLeft = activeItem.offsetLeft + activeItem.offsetWidth / 2 - limelight.offsetWidth / 2;
      limelight.style.left = `${newLeft}px`;

      if (!isReady) {
        setTimeout(() => setIsReady(true), 50);
      }
    }
  }, [activeIndex, isReady, items]);

  if (items.length === 0) {
    return null;
  }

  const handleItemClick = (index: number, itemOnClick?: () => void) => {
    setActiveIndex(index);
    onTabChange?.(index);
    itemOnClick?.();
  };

  return (
    <nav
      className={`relative inline-flex items-center h-9 rounded-full border border-white/10 bg-[#06070c]/80 backdrop-blur-xl px-1 gap-0.5 ${className ?? ''}`}
      style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)' }}
    >
      {items.map(({ id, icon, label, onClick }, index) => (
        <a
          key={id}
          ref={el => (navItemRefs.current[index] = el)}
          title={label}
          aria-label={label}
          className={`relative z-20 flex h-full cursor-pointer items-center justify-center px-3 rounded-full transition-all duration-200 ${
            activeIndex === index
              ? 'bg-white/[0.08]'
              : 'hover:bg-white/[0.04]'
          } ${iconContainerClassName ?? ''}`}
          onClick={() => handleItemClick(index, onClick)}
        >
          {cloneElement(icon, {
            className: `w-4 h-4 transition-all duration-150 ease-in-out ${
              activeIndex === index ? 'opacity-100 scale-110' : 'opacity-35 scale-100'
            } ${icon.props.className || ''} ${iconClassName || ''}`,
            style: activeIndex === index ? { color: accentColor, filter: `drop-shadow(0 0 6px ${accentColor}80)` } : {},
          })}
        </a>
      ))}

      {/* Limelight beam indicator */}
      <div
        ref={limelightRef}
        className={`absolute top-0 z-10 w-10 h-[2px] rounded-full ${
          isReady ? 'transition-[left] duration-300 ease-in-out' : ''
        } ${limelightClassName ?? ''}`}
        style={{
          left: '-999px',
          background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
          boxShadow: `0 0 12px 2px ${accentColor}60, 0 0 40px 8px ${accentColor}20`,
        }}
      >
        {/* Spotlight cone */}
        <div
          className="absolute left-[-25%] top-[2px] w-[150%] h-12 pointer-events-none"
          style={{
            clipPath: 'polygon(8% 100%, 28% 0, 72% 0, 92% 100%)',
            background: `linear-gradient(180deg, ${accentColor}25 0%, transparent 100%)`,
          }}
        />
      </div>
    </nav>
  );
};
