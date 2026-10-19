// Port of liquidglass-widgets lib/colors.js
// Colors for Glass and Solid modes, with Dark/Light/Auto appearance support.
// Colors are {r, g, b, a} with channels in 0..1.

export function rgba(hex, alpha = 1) {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: alpha,
    };
}

export function withAlpha(c, a) {
    return {r: c.r, g: c.g, b: c.b, a};
}

/**
 * Generate color palette for glass/solid styles
 * @param {number} styleMode - 0 = Glass, 1 = Solid
 * @param {number} appearance - 0 = Dark, 1 = Light, 2 = Follow system
 * @param {boolean} systemIsDark - Current system theme preference
 * @returns Color palette object
 */
export function macColors(styleMode, appearance, systemIsDark) {
    const isGlass = styleMode === 0;
    const isSolid = styleMode === 1;
    const wantsLight = appearance === 1 || (appearance === 2 && !systemIsDark);

    // isLight is light *solid* mode only; light glass is glassIsLight.
    const isLight = !isGlass && wantsLight;
    const glassIsLight = isGlass && wantsLight;

    return {
        isGlass,
        isSolid,
        isLight,
        glassIsLight,
        foreground: rgba((isGlass ? glassIsLight : isLight) ? '#1A1B1E' : '#ffffff'),
        glassTint: rgba(glassIsLight ? '#ffffff' : '#000000'),
        solidBackground: rgba(isLight ? '#ffffff' : '#1A1B1E'),
        accentRed: rgba(isLight ? '#D70015' : '#FF3B30'),

        // Calendar: today badge is white on dark glass, red otherwise; on
        // glass the day number is punched out of the badge.
        todayAccent: isGlass && !glassIsLight
            ? rgba('#ffffff')
            : rgba(isLight || glassIsLight ? '#D70015' : '#FF3B30'),
        punchOutText: isGlass,

        // Cards (calendar events, timer presets): white on dark, black on light.
        cardBackground: rgba(isLight || glassIsLight ? '#000000' : '#ffffff'),
        cardBackgroundOpacity: isLight || glassIsLight ? 0.08 : 0.10,
        cardHoverOpacity: isLight || glassIsLight ? 0.14 : 0.17,
        cardPressOpacity: isLight || glassIsLight ? 0.20 : 0.22,

        // Timer: solid-filled action buttons on glass, tinted ones on solid.
        countdownText: rgba(isGlass && !glassIsLight ? '#ffffff' : '#FF8B00'),
        actionGreen: rgba('#00A832'),
        actionOrange: rgba('#FF8E00'),
        buttonIcon: rgba(isGlass ? (glassIsLight ? '#1A1B1E' : '#ffffff')
            : (isLight ? '#1A1B1E' : '#ffffff')),
        cancelButtonBg: isGlass
            ? (glassIsLight ? rgba('#000000', 0.12) : rgba('#ffffff', 0.25))
            : rgba(isLight ? '#1A1B1E' : '#ffffff', 0.12),
        actionGreenBg: isGlass ? rgba('#00A832') : rgba('#00A832', 0.18),
        actionOrangeBg: isGlass ? rgba('#FF8E00') : rgba('#FF8E00', 0.18),

        // Weather: text and the mono icons follow the glass tint; Solid draws
        // white on the weather gradient with the colored icons.
        weatherForeground: rgba(isGlass && glassIsLight ? '#1A1B1E' : '#ffffff'),
        weatherIconSet: isGlass ? (glassIsLight ? 'mono-dark' : 'mono-light') : 'default',
        weatherSeparator: isGlass && glassIsLight
            ? rgba('#000000', 0.12)
            : rgba('#ffffff', isGlass ? 0.15 : 0.20),
        weatherRangeBarBg: isGlass && glassIsLight
            ? rgba('#000000', 0.10)
            : rgba('#ffffff', isGlass ? 0.12 : 0.15),
        weatherRangeBarFill: isGlass && glassIsLight
            ? rgba('#000000', 0.45)
            : rgba('#ffffff', isGlass ? 0.50 : 0.60),
    };
}

// Solid-style weather backdrop, [top, bottom], by gradient category.
const WEATHER_GRADIENTS = {
    clear: ['#5188BD', '#194E84'],
    cloudy: ['#8E9EAF', '#4A5568'],
    rain: ['#607B8A', '#2C3E50'],
    storm: ['#3A3A4A', '#1A1A2E'],
    snow: ['#B0C4DE', '#708090'],
    fog: ['#9CA3AF', '#6B7280'],
    nightclear: ['#1A1A3E', '#0D0D2B'],
    nightcloudy: ['#2C3040', '#1A1E2A'],
};

export function weatherGradient(category) {
    const [top, bottom] = WEATHER_GRADIENTS[category] ?? WEATHER_GRADIENTS.clear;
    return [rgba(top), rgba(bottom)];
}
