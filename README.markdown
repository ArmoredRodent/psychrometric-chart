# Psychrometric Chart

View the live chart at: [psychrochart.com](https://psychrochart.com)!

Goals of this psychrometric chart:

- Open source and accessible online.
- Dynamic and adjustable parameters for chart construction.
- High-quality visualization and exports (SVG and PNG).
- Lightweight page load. No unwanted ads or fluff.
- Just static HTML, JavaScript, and CSS, no need to have an internet
  connection, just a web browser.

## Technologies used

* Chart is created using [d3.js](https://d3js.org/)
* Front-end framework: [knockout.js](https://knockoutjs.com)
* [SaveSvgAsPng](https://github.com/exupero/saveSvgAsPng)
* Nothing else!

## Still to do:

- [x] Show other calculated psychrometric properties for states.
- [x] Use other properties besides humidity ratio for fixing states.
- [x] User-defined color schemes.

---------------------------------------------------------------------------
View the live chart at: https://wulflemm.com/applets/PsychrometricChart/ !

## Changes
Too many changes to really document.
- Added Tabs.
- Added selectable outputs for each state.
- Added chart colors (default (6) and user selected (3)).
- Added editable titles for multilanguage support.
- Added dropdown to select input. 
- Added Tbd & %RH and Tbd & Twb to control state selection.
- Limit state selection within chart.
- Local storage for all variables so users can go to their default state.
- Fixed bug where Vapor Press did not update as Max ω > 0.3.
- Added Altitude (14.7psi vs 14.696psi at 0ft).
- Added Minimum Temperature (10°F).
- Add Vapor Pressure to Show Chart.
- Set font for RH and Twb to fix a bug where saved svg fonts were larger than chart.
- Up to 3 states can be loaded from url.  https://wulflemm.com/applets/PsychrometricChart/index.html?Tdb1=75&w=0.0168241&Tdb2=90&Tdb3=105&w3=0.0242502 - Three states
- Rearranged order of svg elements - axis, chart, border.
- Added draw line with mouse + spacebar = very crude.

  ## Additional Technologies used
* Local storage of ko variables: https://github.com/jimrhoskins/knockout.localStorage/blob/master/knockout.localStorage.js
* Color Picker: https://www.educative.io/answers/how-to-add-a-color-picker-in-html
* SaveSVG: https://stackoverflow.com/questions/23218174/how-do-i-save-export-an-svg-file-after-creating-an-svg-with-d3-js-ie-safari-an
* Metric psychrometric calculations: https://www.kwangu.com/work/psychrometric.htm

Goal:  Dynamic chart that can be used in multiple ways.  One chart to rule them all!
