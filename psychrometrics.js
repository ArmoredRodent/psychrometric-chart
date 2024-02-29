/* global ko, d3 */
/* global Blob */
/* global saveSvgAsPng */

const c8 = -1.0440397e4;
const c9 = -1.129465e1;
const c10 = -2.7022355e-2;
const c11 = 1.289036e-5;
const c12 = -2.4780681e-9;
const c13 = 6.5459673;

const minTemp = 32;

const Rda = 53.35; // Dry air gas constant, ft-lbf / lbda-R

var pixelWidth = 1400;
var pixelHeight = 800;

var xOffsetPercentLeft = 2;
var xOffsetPercentRight = 12;
var yOffsetPercent = 8;
//var yOffsetPercentTop = 2;
//var yOffsetPercentBottom = 4;

var yCanvasRange = [
	pixelHeight - (yOffsetPercent * pixelHeight) / 100,
	((yOffsetPercent) * pixelHeight) / 100
];


function getRandomInt(min, max) {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min)) + min; //The maximum is exclusive and the minimum is inclusive
}

function getRandomArbitrary(min, max) {
	return Math.random() * (max - min) + min;
}

function newtonRaphson(zeroFunc, derivativeFunc, initialX, tolerance) {
	if (typeof tolerance === "undefined") tolerance = 0.0001;

	var testX = initialX;
	while(Math.abs(zeroFunc(testX)) > tolerance) {
		testX = testX - zeroFunc(testX) / derivativeFunc(testX);
	}
	return testX;
}

// Utility method that guarantees that min and max are exactly
// as input, with the step size based on 0.
function range(min, max, stepsize) {
	var parsedMin = parseFloat(min);
	var toReturn = parsedMin % stepsize === 0 ? [] : [parsedMin];
	var n = 0;
	var baseValue = stepsize * Math.ceil(parsedMin / stepsize);
	while (baseValue + n * stepsize < parseFloat(max)) {
		toReturn.push(baseValue + n * stepsize);
		n = n + 1;
	}

	toReturn.push(max);
	return toReturn;
}

// Saturation pressure in psi from temp in °F.
function satPressFromTempIp(temp) {
	var t = temp + 459.67;
	var lnOfSatPress =
		c8 / t +
		c9 +
		c10 * t +
		c11 * Math.pow(t, 2) +
		c12 * Math.pow(t, 3) +
		c13 * Math.log(t);
	var satPress = Math.exp(lnOfSatPress);
	return satPress;
}

function satHumidRatioFromTempIp(temp, totalPressure) {
	if (arguments.length !== 2) throw Error(`Not all parameters specified. temp: ${temp}; P: ${totalPressure}`);
	var satPress = satPressFromTempIp(temp);
	return (0.621945 * satPress) / (totalPressure - satPress);
}

function wFromPv(pv, totalPressure) {
	if (arguments.length !== 2) throw Error(`Not all parameters specified. pv: ${pv}; P: ${totalPressure}`);
	return (0.621945 * pv) / (totalPressure - pv);
}

function pvFromw(w, totalPressure) {
	if (typeof w === "string") w = parseFloat(w);
	if (w < 0.000001) return 0;
	return totalPressure / (1 + 0.621945 / w);
}

// partial pressure of vapor from dry bulb temp (°F) and rh (0-1)
function pvFromTempRh(temp, rh) {
	if (rh < 0 || rh > 1) throw new Error("RH value must be between 0-1");
	return rh * satPressFromTempIp(temp);
}

function tempFromRhAndPv(rh, pv) {
	if (!rh || rh > 1) throw new Error("RH value must be between 0-1");

	var goalPsat = pv / rh;

	// Employ Newton-Raphson method.
	function funcToZero(temp) {
		return satPressFromTempIp(temp) - goalPsat;
	}

	var derivativeFunc = (temp) => dPvdT(1, temp);
	return newtonRaphson(funcToZero, derivativeFunc, 80, 0.00001)
}

function tempFromEnthalpyPv(h, pv, totalPressure) {
	var ω = wFromPv(pv, totalPressure);
	return (h - ω * 1061) / (0.24 + ω * 0.445);
}

// Returns object with temperature (°F) and vapor pressure (psia)
function tempPvFromvRh(v, rh, totalPressure) {
	var rAir = 53.35; // Gas constant in units of ft-lbf / lbm - R

	function funcToZero(temp) {
		// The 144 is a conversion factor from psf to psi. The 469.67 is to go from F to R.
		var term1 = satPressFromTempIp(temp) * rh;
		var term2 = (totalPressure - rAir * (temp + 459.67) / (v * 144));
		return term1 - term2;
	}

	function derivative(temp) {
		return dPvdT(rh, temp) + rAir / (v * 144);
	}

	// Employ the Newton-Raphson method.
	testTemp = newtonRaphson(funcToZero, derivative, 80);
	return { temp: testTemp, pv: pvFromTempRh(testTemp, rh) };
}

function WetBulbRh(wetBulb, rh, totalP) {
	if (rh < 0 || rh > 1) {
		throw new Error("RH expected to be between 0 and 1");
	}

	function funcToZero(testTemp) {
		ω1 = ωFromWetbulbDryBulb(wetBulb, testTemp, totalP);
		pv2 = rh * satPressFromTempIp(testTemp);
		ω2 = wFromPv(pv2, totalP);
		return ω1 - ω2;
	}

	var updatedMaxTemp = 200;
	var updatedMinTemp = 0;
	var looping = true;

	while (looping) {
		var testTemp = (updatedMaxTemp + updatedMinTemp) / 2;

		var result = funcToZero(testTemp);

		if (Math.abs(result) < 0.00001) {
			looping = false;
		}
		else {
			// Too low case
			if (result > 0) {
				updatedMinTemp = testTemp;
			}
			else { updatedMaxTemp = testTemp; }
		}
	}

	return { temp: testTemp, pv: pvFromTempRh(testTemp, rh) }
}

// temp: Dry bulb temperature in °F
// ω: Humidity ratio
// totalPressure: Total Pressure in psia.
function wetBulbFromTempω(temp, ω, totalPressure) {
	
	// Function we'd like to 0. A difference in ω's.
	function testWetbulbResult(testWetbulb) {
		var satωAtWetBulb = satHumidRatioFromTempIp(testWetbulb, totalPressure);

		return ((1093 - 0.556 * testWetbulb) * satωAtWetBulb - 0.24 * (temp - testWetbulb)) /
			(1093 + 0.444 * temp - testWetbulb) - ω;
	}

	var updatedMaxTemp = temp;
	var updatedMinTemp = 0;

	var testTemp = (Number(updatedMaxTemp) + Number(updatedMinTemp)) / 2;

	var iterations = 0;

	var testResult = testWetbulbResult(testTemp);
	while (Math.abs(testResult) > 0.000001) {
		if (iterations > 500) {
			throw new Error("Infinite loop in temp from Rh and Pv.");
		}

		// Number - calcs became confused that number was text
		if (Number(updatedMaxTemp) === Number(updatedMinTemp))
			return testTemp;			// kludge for point close to saturation
			
		if (testResult > 0) {
			updatedMaxTemp = testTemp;
			testTemp = (Number(updatedMaxTemp) + Number(updatedMinTemp)) / 2;
		} else {
			updatedMinTemp = testTemp;
			testTemp = (Number(updatedMaxTemp) + Number(updatedMinTemp)) / 2;
		}

		testResult = testWetbulbResult(testTemp);
		iterations++;
	}
	return testTemp;
}


function tempFromWetbulbω(wetBulb, ω, totalPressure) {
	var ωsatWetBulb = satHumidRatioFromTempIp(wetBulb, totalPressure);
	return ((1093 - 0.556 * wetBulb) * ωsatWetBulb + 0.24 * wetBulb - ω * (1093 - wetBulb)) / (0.444 * ω + 0.24);
}

function ωFromWetbulbDryBulb(wetbulbTemp, temp, totalPressure) {
	var ωsatWetBulb = satHumidRatioFromTempIp(wetbulbTemp, totalPressure);
	return ((1093 - 0.556 * wetbulbTemp) * ωsatWetBulb - 0.24 * (temp - wetbulbTemp)) / (1093 + 0.444 * temp - wetbulbTemp);
}

function vFromTempω(temp, ω, totalPressure) {
	return 0.370486 * (temp + 459.67) * (1 + 1.607858 * ω) / totalPressure;
}

function tempFromvω(v, ω, totalPressure) {
	return (v * totalPressure) / (0.370486 * (1 + 1.607858 * ω)) - 459.67;
}

function ωFromTempv(temp, v, totalPressure) {
	var numerator = ((totalPressure * v) / (0.370486 * (temp + 459.67))) - 1;
	return numerator / 1.607858;
}

// Calculate derivative of pv vs. T at given RH (0-1) and temp (°F)
function dPvdT(rh, temp) {
	if (rh < 0 || rh > 1) throw Error("rh should be specified 0-1");
	var absTemp = temp + 459.67;
	var term1 =
		-c8 / (absTemp * absTemp) +
		c10 +
		2 * c11 * absTemp +
		3 * c12 * absTemp * absTemp +
		c13 / absTemp;
	return rh * satPressFromTempIp(temp) * term1;
}

var keyPressed = false;

var p = d3.select('body')
  .on("keypress", function() {
    if(event.keyCode === 32){
		keyPressed = true;
    }
  })
  .on("keyup", function() {
		keyPressed = false;
  })
 
var svg = d3.select("svg")
    .on("mousedown", mousedown)
    .on("mouseup", mouseup);

svg.style("width", pixelWidth + "px");
svg.style("height", pixelHeight + "px");

var line;
var selection;

function mousedown() {
    var m = d3.pointer(event,this);

	if (keyPressed) {
		selection = svg.select("#vectors");

		line = selection.append("line")
			.attr("fill", "none")
			.attr("stroke", "red")
			.attr("stroke-width", 4)
			.attr("stroke-linecap", "round")
			.attr("x1", m[0])
			.attr("y1", m[1])
			.attr("x2", m[0])
			.attr("y2", m[1]);
		 
   	svg.on("mousemove", mousemove);
	}
}

function mousemove() {
    var m = d3.pointer(event,this);
    line.attr("x2", m[0])
        .attr("y2", m[1]);
}

function mouseup() {
    svg.on("mousemove", null);
}


function humidityRatioFromEnthalpyTemp(enthalpy, temp) {
	return (enthalpy - 0.24 * temp) / (1061 + 0.445 * temp);
}

function enthalpyFromTempPv(temp, pv, totalPressure) {
	var ω = wFromPv(pv, totalPressure);
	return 0.24 * temp + ω * (1061 + 0.445 * temp);
}

function enthalpyFromTempω(temp, ω) {
	return 0.24 * temp + ω * (1061 + 0.445 * temp);
}

function pvFromEnthalpyTemp(enthalpy, temp, totalPressure) {
	return pvFromw(humidityRatioFromEnthalpyTemp(enthalpy, temp), totalPressure);
}

function satTempAtEnthalpy(enthalpy, totalPressure) {
	var currentLowTemp = 0;
	var currentHighTemp = 200;

	var error = 1;
	var testTemp = (currentLowTemp + currentHighTemp) / 2;

	var iterations = 0;
	do {
		iterations++;
		if (iterations > 500) throw Error("Inifite loop in satTempAtEnthalpy");
		testTemp = (currentLowTemp + currentHighTemp) / 2;
		var testSatHumidityRatio = satHumidRatioFromTempIp(testTemp, totalPressure);
		var testHumidityRatio = humidityRatioFromEnthalpyTemp(
			enthalpy,
			testTemp
		);

		error = testSatHumidityRatio - testHumidityRatio;
		if (testSatHumidityRatio > testHumidityRatio) {
			currentHighTemp = testTemp;
		} else {
			currentLowTemp = testTemp;
		}
	} while (Math.abs(error) > 0.00005);

	return testTemp;
}

function isMult(val, mult) { return val % mult === 0; }

var constantRHvalues = [10, 20, 30, 40, 50, 60, 70, 80, 90];

function RHfromTdbTwb (TempDryBulb, TempWetBulb, altitude)
{
	var Tdb = (TempDryBulb-32)*(5/9);
	var Twb = (TempWetBulb-32)*(5/9);
	var alt = altitude / 3.28084;

    var p = findpressure(alt);
    var p_ws_wb=saturation_pressure(Twb);
    var ws_wb=humidity_ratio(p_ws_wb,p);
    var w=equation_33(Twb,ws_wb,Tdb);
    var p_ws=saturation_pressure(Tdb);
    var ws=humidity_ratio(p_ws,p);
    var mew=degree_saturation(w,ws); 
    var rh=rel_humidity(mew,p_ws,p);
//    var v=specific_volume(Tdb,w,p);
//    var h=enthalpy(w,Tdb);
//    var p_w=equation_36(p,w);
//    var t_d=dewpoint(p_w);
//    var rho=density(v,w);  
 
	return rh;
}

function TdfromTdbTwb (TempDryBulb, TempWetBulb, altitude)
{
	var Tdb = (TempDryBulb-32)*(5/9);
	var Twb = (TempWetBulb-32)*(5/9);
	var alt = altitude / 3.28084;

    var p = findpressure(alt);
    var p_ws_wb=saturation_pressure(Twb);
    var ws_wb=humidity_ratio(p_ws_wb,p);
    var w=equation_33(Twb,ws_wb,Tdb);
    var p_w=equation_36(p,w);
    var t_d=dewpoint(p_w)*9/5+32;
 
	return t_d;
}

function Group(label, children) {
    this.label = ko.observable(label);
    this.children = ko.observableArray(children);
}

function Option(label, property) {
    this.label = ko.observable(label);
    this.someOtherProperty = ko.observable(property);
}

(function(ko){
  // Wrap ko.observable and ko.observableArray
  var methods = ['observable', 'observableArray'];

  ko.utils.arrayForEach(methods, function(method){
    var saved = ko[method];
    
    ko[method] = function(initialValue, options){
      options = options || {};

      var key = options.persist;

      // Load existing value if set
      if(key && localStorage.hasOwnProperty(key)){
        try{
          initialValue = JSON.parse(localStorage.getItem(key))
        }catch(e){};
      }

      // Create observable from saved method
      var observable = saved(initialValue);

      // Subscribe to changes, and save to localStorage
      if(key){
        observable.subscribe(function(newValue){
          localStorage.setItem(key, ko.toJSON(newValue));
        });
      };

      return observable;
    }
  })
})(ko);

function StateTempω(maxTemp, maxω, name, totalPressure, altitude, numStates) {
	var self = this;

	this.groups = ko.observableArray([
		new Group("", [
			new Option("ω", 0),
			new Option("\%RH", 1),
			new Option("Twb", 2)
		])
	]);

	this.selectedOption = ko.observable();

	this.specialProperty = ko.computed(function(){
		var selected = this.selectedOption();
		return selected ? selected.someOtherProperty() : 'unknown';
	}, this);

	self.RoundRH = ko.observable(100);
	self.RoundTwb = ko.observable(100);

	self.totalPressureInput = ko.observable(totalPressure);

	var tmp = getRandomInt(minTemp, maxTemp);
	
	if (urlParams["Tdb"] != null && numStates === 0)
		tmp = urlParams["Tdb"]*1;
	else if (urlParams["Tdb1"] != null && numStates === 0)
		tmp = urlParams["Tdb1"]*1;
	if (urlParams["Tdb2"] != null && numStates === 1)
		tmp = urlParams["Tdb2"]*1;
	if (urlParams["Tdb3"] != null && numStates === 2)
		tmp = urlParams["Tdb3"]*1;

	self.Tdb = ko.observable(tmp).extend({ numeric: 2, logChange: "Tdb"});
	self.TdbLast = ko.observable(self.Tdb());

	maxωrange = Math.min(satHumidRatioFromTempIp(self.Tdb(), self.totalPressureInput()), maxω);
	
	tmp = Math.round(getRandomArbitrary(0, maxωrange) * 1000) / 1000;
	if (urlParams["w"] != null && numStates === 0 && 
		 (urlParams["Tdb"] != null || urlParams["Tdb1"] != null))
		tmp = urlParams["w"]*1;
	if (urlParams["w1"] != null && numStates === 0 && 
		 (urlParams["Tdb"] != null || urlParams["Tdb1"] != null))
		tmp = urlParams["w1"]*1;
	if (urlParams["w2"] != null && numStates === 1 && urlParams["Tdb2"] != null)
		tmp = urlParams["w2"]*1;
	if (urlParams["w3"] != null && numStates === 2 && urlParams["Tdb3"] != null)
		tmp = urlParams["w3"]*1;

	self.humidityRatio = ko.observable(tmp).extend({ numeric: 2, logChange: "w"});
	self.humidityRatioLast = ko.observable(self.humidityRatio());
	
//console.log(self.Tdb());		
//console.log(self.humidityRatio());
// Looking for rare crash - close to saturation line
// ω with rounding is (possibly) above saturation line

	self.pv = ko.computed(() => Math.round(pvFromw(self.humidityRatio(), self.totalPressureInput()) * 10000) / 10000);
	self.name = ko.observable(name);

	self.Twb = ko.observable(Math.round(wetBulbFromTempω(self.Tdb(), self.humidityRatio(), self.totalPressureInput()) * 100) / 100).extend({ numeric: 2, logChange: "Twb"});
	
	self.enthalpy = ko.computed(() => Math.round(enthalpyFromTempPv(self.Tdb(), self.pv(), self.totalPressureInput()) * 100) / 100);

// viewModel is not defined!!!!!  kludge time

//	var tmp = viewModel.altitudeInput();

//console.log("altitude", viewModel.altitudeInput());

//	self.RH = ko.observable(Math.round(RHfromTdbTwb(self.Tdb(), self.Twb(), viewModel.altitudeInput()) * self.RoundRH()) / self.RoundRH()).extend({ numeric: 2, logChange: "RH"});
	self.RH = ko.observable(Math.round(RHfromTdbTwb(self.Tdb(), self.Twb(), altitude) * self.RoundRH()) / self.RoundRH()).extend({ numeric: 2, logChange: "RH"});

	self.Td = ko.observable(Math.round(TdfromTdbTwb(self.Tdb(), self.Twb(), altitude) * 100) / 100).extend({ numeric: 2, logChange: "Td"});
	
	self.v = ko.computed(() => Math.round(vFromTempω(Number(self.Tdb()), Number(self.humidityRatio()), Number(self.totalPressureInput())) * 100) / 100);

//˄˄˄˄˄˄˄˄˄˄˄
// Some variables within States for debugging
	self.Test1 = ko.computed(function(){
		return enthalpyFromTempω(maxTemp, self.humidityRatio())
	},self);

	self.Test2 = ko.computed(function(){
		var temp = satTempAtEnthalpy(self.Test1(), self.totalPressureInput());
		return satHumidRatioFromTempIp(temp, self.totalPressureInput());
	},self);
//˅˅˅˅˅˅˅˅˅˅˅

	self.humidityRatio.subscribe(function (val) {
		val = Number(val);
		var Tdb = (self.Tdb()-32)*(5/9);
		var altitude = viewModel.altitudeInput() / 3.28084;
		var p = findpressure(altitude);
		var p_ws=saturation_pressure(Tdb);
		var w = humidity_ratio(p_ws,p); 

//		var w = satHumidRatioFromTempIp(self.Tdb(), self.totalPressureInput());// not working after we max to saturation, goes to 0
		if (val > viewModel.maxωInput())			// Upper limit`
		{
				self.humidityRatio(viewModel.maxωInput());
				// Do calcs first time to get numbers, otherwise abort
				if (self.humidityRatio() === self.humidityRatioLast())	
					return;			
		}
		else if (val < 0)								// lower limit
		{
				self.humidityRatio(0);
				if (self.humidityRatio() === self.humidityRatioLast())	
					return;			
		}
		else if (val > w)								// saturation line
		{
				self.humidityRatio(Math.round(w * 1000000) / 1000000);
				return;			
		}
		self.humidityRatioLast(val);
		
		if (self.specialProperty() === 0)
		{
			self.Twb(Math.round(wetBulbFromTempω(self.Tdb(), val, self.totalPressureInput()) * 100) / 100);
			self.RH(Math.round(RHfromTdbTwb(self.Tdb(), self.Twb(), viewModel.altitudeInput()) * self.RoundRH()) / self.RoundRH());
			self.Td(Math.round(TdfromTdbTwb(self.Tdb(), self.Twb(), viewModel.altitudeInput()) * 100) / 100);
			self.RoundRH(100);
		}
	}, self);

	self.RH.subscribe(function (val) {
		if (self.specialProperty() === 1)
		{
			self.RoundRH(1);
			if (val >=0 && val <=100)
			{
				var Tdb = (self.Tdb()-32)*(5/9);
				var altitude = viewModel.altitudeInput() / 3.28084;
				var p = findpressure(altitude);
				var p_ws=saturation_pressure(Tdb);
				var p_w=p_ws*val/100.0;
				var w = Math.round(humidity_ratio(p_w,p) * 1000000) / 1000000; 

				if (w > viewModel.maxωInput())
				{
					self.humidityRatio(viewModel.maxωInput());
					self.Twb(Math.round(wetBulbFromTempω(self.Tdb(), self.humidityRatio(), self.totalPressureInput()) * 100) / 100);
					self.RH(Math.round(RHfromTdbTwb(self.Tdb(), self.Twb(), viewModel.altitudeInput()) * self.RoundRH()) / self.RoundRH());
					self.Td(Math.round(TdfromTdbTwb(self.Tdb(), self.Twb(), viewModel.altitudeInput()) * 100) / 100);
						return;
				}
				else if (w < 0)
				{
						self.humidityRatio(0);
						return;
				}
					self.humidityRatio(w);
				var ws = humidity_ratio(p_ws,p);
				var mew=degree_saturation(w,ws); 
				var v=specific_volume(Tdb,w,p);
				var h=enthalpy(w,Tdb);
				var t_d=dewpoint(p_w);
				self.Td(Math.round((t_d * 9/5 + 32)*100)/100);
				var rho=density(v,w);
				var t_wb=calcwetbulb(Tdb,p,w);
				self.Twb(Math.round((t_wb * 9/5 + 32)*100)/100);
			}
			else if (val < 0)
				self.RH(0);
			else if (val > 100)
				self.RH(100);
		}
	}, self);

	self.Twb.subscribe(function (val) {
		if (self.specialProperty() === 2)
		{
			if (val <= self.Tdb())
			{
			self.RoundRH(100);
			var Twb = (val-32)*(5/9);
			var Tdb = (self.Tdb()-32)*(5/9);
			var altitude = viewModel.altitudeInput() / 3.28084;
			var p = findpressure(altitude);
			var p_ws_wb=saturation_pressure(Twb);
			var ws_wb=humidity_ratio(p_ws_wb,p);
			var w=equation_33(Twb,ws_wb,Tdb);
				self.humidityRatio(Math.round(w * 1000000) / 1000000);
			var p_ws=saturation_pressure(Tdb);
			var ws=humidity_ratio(p_ws,p);
			var mew=degree_saturation(w,ws); 
			var rh=rel_humidity(mew,p_ws,p);
			self.RH(Math.round(rh * self.RoundRH()) / self.RoundRH());
			var v=specific_volume(Tdb,w,p);
			var h=enthalpy(w,Tdb);
			var p_w=equation_36(p,w);
			var t_d=dewpoint(p_w);
			self.Td(Math.round((t_d * 9/5 + 32)*100)/100);
			var rho=density(v,w);
			}
			else 
				self.Twb(self.Tdb());
		}	
	}, self);

	self.Tdb.subscribe(function (val) {
		if (self.specialProperty() === 0)
		{
			// Check temperature is held within horizontal limits
			var pv = pvFromw(self.humidityRatio(), viewModel.totalPressure());
			if (val > viewModel.maxTemp())			// Upper limits
			{
				if (self.TdbLast() !== viewModel.maxTemp())
				{
					self.Tdb(viewModel.maxTemp());
					return;
				} else {
					self.Tdb(self.TdbLast());
					return;
				}
			}
			else if (val < tempFromRhAndPv(1, pv))
			{										// Lower limit - 100% sat
				self.Tdb(Math.round(tempFromRhAndPv(1, pv)*100)/100);
				
				// Do calcs first time to get numbers, otherwise abort
				if (self.Tdb() === self.TdbLast())	
					return;			
			}
			else if (val < 32)	// Lower limits
			{
				if (self.TdbLast() !== 32)
				{
					self.Tdb(32);
					return;
				} else {
					self.Tdb(self.TdbLast());
					return;
				}
			}
			self.TdbLast(val);				// Save Tbd for limits
			self.Twb(Math.round(wetBulbFromTempω(val, self.humidityRatio(), self.totalPressureInput()) * 100) / 100);
			self.RH(Math.round(RHfromTdbTwb(val, self.Twb(), viewModel.altitudeInput())* self.RoundRH()) / self.RoundRH());
			self.Td(Math.round(TdfromTdbTwb(val, self.Twb(), viewModel.altitudeInput()) * 100) / 100);
		}
		else if (self.specialProperty() === 1)
		{
			self.RoundRH(1);
			var Tdb = (val-32)*(5/9);

			var altitude = viewModel.altitudeInput() / 3.28084;
			var p = findpressure(altitude);
			var p_ws=saturation_pressure(Tdb);
			var p_w=p_ws*self.RH()/100.0;
			var w = Math.round(humidity_ratio(p_w,p) * 1000000) / 1000000;
				// Check temperature is held within horizontal limits
			var pv = pvFromw(self.humidityRatio(), viewModel.totalPressure());
			if (val > viewModel.maxTemp() || val < 32)
			{											// Upper/lower limits
				self.Tdb(self.TdbLast());
				return;
			}
			self.TdbLast(val);					// Save Tbd for limits

			if (w > viewModel.maxωInput())
			{
				self.humidityRatio(viewModel.maxωInput());
				var pv2 = pvFromw(self.humidityRatio(), viewModel.totalPressure());
				self.Tdb(Math.round(tempFromRhAndPv(self.RH()/100, pv2)*100)/100);
				return;
			}
			else if (w < 0)
			{
				self.humidityRatio(0);
				return;
			}
			self.humidityRatio(w);
			var ws = humidity_ratio(p_ws,p);
			var mew=degree_saturation(w,ws); 
			var v=specific_volume(Tdb,w,p);
			var h=enthalpy(w,Tdb);
			var t_d=dewpoint(p_w);
				self.Td(Math.round((t_d * 9/5 + 32)*100)/100);
			var rho=density(v,w);
			var t_wb=calcwetbulb(Tdb,p,w);
				self.Twb(Math.round((t_wb * 9/5 + 32)*100)/100);
		}
		else if (self.specialProperty() === 2)
		{
			val = Number(val);
			if (val > viewModel.maxTemp())			// Upper limits
			{
				self.Tdb(viewModel.maxTemp());
			}
			else if (val < 32)			// Lower limits
			{
				self.Tdb(32);
			}
			else if (val >= self.Twb())
			{
				var Twb = (self.Twb()-32)*(5/9);
				var Tdb = (val-32)*(5/9);
				var altitude = viewModel.altitudeInput() / 3.28084;
				var p = findpressure(altitude);
				var p_ws_wb=saturation_pressure(Twb);
				var ws_wb=humidity_ratio(p_ws_wb,p);
				var w=equation_33(Twb,ws_wb,Tdb);
				if (w <= 0)
				{
					w = 0;
					self.humidityRatio(0)
					self.Tdb(self.TdbLast());
					Tdb = (self.Tdb()-32)*(5/9);
					return;
				}
				else
					self.humidityRatio(Math.round(w * 1000000) / 1000000);
				self.TdbLast(val)
				var p_ws=saturation_pressure(Tdb);
				var ws=humidity_ratio(p_ws,p);
				var mew=degree_saturation(w,ws); 
				var rh=rel_humidity(mew,p_ws,p);
				self.RH(Math.round(rh * self.RoundRH()) / self.RoundRH());
				var v=specific_volume(Tdb,w,p);
				var h=enthalpy(w,Tdb);
				var p_w=equation_36(p,w);
				var t_d=dewpoint(p_w);
				self.Td(Math.round((t_d * 9/5 + 32)*100)/100);
				var rho=density(v,w);
			}
			else
			{
				self.Tdb(self.Twb());
			}
		}
	}, self);
}

var radius = 160;

const arcGenerator = d3.arc()
  .outerRadius(radius)
  .innerRadius(radius-1)
  .startAngle(Math.PI / 2)
  .endAngle(3 * Math.PI / 2 );

function ViewModel() {
	var self = this;
	// Start by creating svg elements in the order that I want
	// them layered. The later items will be on top of the earlier items.
	svg.append("g").attr("id", "x-axis");
	svg.append("g").attr("id", "yAxisHumid");
	var yAxisSelection = svg.append("g").attr("id", "yAxis");

	var vPaths = svg.append("g").attr("id", "vpaths");
	svg.append("g").attr("id", "specific-humidity-lines");
	var wetBulbPaths = svg.append("g").attr("id", "wetbulb-lines");
	var enthalpyPaths = svg.append("g").attr("id", "enthalpyLines");
	svg.append("g").attr("id", "rh-lines");
	svg.append("g").attr("id", "temp-lines");

	self.BackgroundColor = ko.observable("#FFFFFF", {persist: 'BackgroundColor'})

	self.ForegroundColor = ko.observable("#000000", {persist: 'ForegroundColor'})

	var enthalpyBorderPath = svg.append("g").attr("id", "enthalpy-border").append("path");

	var summerComfortZone = svg.append("g").attr("id", "SummerComfortZone").append("path");

	var hLabels = svg.append("g").attr("id", "h-labels");
	svg.append("g").attr("id", "boundary-lines").append("path")
		.attr("stroke", self.ForegroundColor())
		.attr("stroke-width", 2)
		.attr("fill", "none");

	svg.append("g").attr("id", "rh-label-background");
	// contains labels AND backgrounds
    var rhticks = svg
        .append("g")
        .attr("class", "ticks")
        .attr("id", "rh-ticks");

	svg.append("g").attr("id", "v-label-backgrounds");
	svg.append("g").attr("id", "v-labels");

	svg.append("g").attr("id", "wetbulb-labels-backgrounds");
	svg.append("g").attr("id", "wetbulb-labels");

	svg.append("g").attr("id", "dewpoint-backgrounds");
	svg.append("g").attr("id", "dewpointlabels");

	var scaleLabels = svg.append("g").attr("id", "ScaleLabels");
		scaleLabels.append("g").attr("id", "tdb-label");
		scaleLabels.append("g").attr("id", "humidity-label");
		scaleLabels.append("g").attr("id", "vaporPressure-label");
		scaleLabels.append("g").attr("id", "enthalpy-label");

	// Put specific states within the states group
	var states = svg.append("g").attr("id", "states");
	states.append("g").attr("id", "state-circles");
	states.append("g").attr("id", "state-backgrounds");
	states.append("g").attr("id", "state-text");

	svg.append("g").attr("id", "protractor");

	svg.append("g").attr("id", "vectors");

	self.maxTempInput = ko.observable("120", {persist: 'MaxTempInput'}).extend({ rateLimit: 500 });
	self.minTempInput = ko.observable("32", {persist: 'MinTempInput'}).extend({ rateLimit: 500 });

	self.maxTemp = ko.computed(() => {
		var parsedValue = parseInt(self.maxTempInput());
		if (!isNaN(parsedValue) && parsedValue > self.minTempInput() && parsedValue <= 180) return parsedValue;
		return 120;
	});

	self.minTemp = ko.computed(() => {
		var parsedValue = parseInt(self.minTempInput());
		if (!isNaN(parsedValue) && parsedValue < self.maxTempInput() && parsedValue >= 10) return parsedValue;
		return 32;
	});

	self.totalPressureInput = ko.observable("14.696", {persist: 'TotalPressureInput'}).extend({ rateLimit: 500 });
	
	self.totalPressure = ko.pureComputed(() => {
		var parsedValue = parseFloat(self.totalPressureInput());
		if (!isNaN(parsedValue) && parsedValue > 10 && parsedValue < 20) return parsedValue;
		return 14.696;
	});

    self.altitudeInput = ko.computed({
        read: function() { 
		   var height = Math.round(145446*(1-Math.pow(self.totalPressure()/14.696, 1/5.2559))/1)*1;

			return height;
        },
        write: function(val){
			self.totalPressureInput(Math.round((14.696 * Math.pow(1-6.8754e-6*val,5.2559))*10000)/10000);
        }
    });

	var tmp = self.altitudeInput();
console.log("Altitude is set:", tmp);
	
	self.maxωInput = ko.observable("0.03", {persist: 'MaxωInput'}).extend({ rateLimit: 500 });
	self.maxω = ko.pureComputed(() => {
		var parsedValue = parseFloat(self.maxωInput());
		if (!isNaN(parsedValue) && parsedValue > 0 && parsedValue < 0.07) return parsedValue;
		return 0.03;
	});

	self.xScale = ko.pureComputed(() => {
		return d3.scaleLinear()
			.domain([self.minTemp(), self.maxTemp()])
			.range([
				(xOffsetPercentLeft * pixelWidth) / 100,
				pixelWidth - (xOffsetPercentRight * pixelWidth) / 100
			]);
	});

	self.pixelsPerTemp = ko.pureComputed(() => self.xScale()(1) - self.xScale()(0));
	self.pixelsPerPsia = ko.pureComputed(() => self.yScale()(1) - self.yScale()(0));

	// Return angle in °, given slope in units of psi / °F
	angleFromDerivative = derivative =>
				(Math.atan(derivative * self.pixelsPerPsia() / (self.pixelsPerTemp())
				) * 180) / Math.PI;

	self.maxPv = ko.pureComputed(() => pvFromw(self.maxω(), self.totalPressure()) );

	self.yScale = ko.pureComputed(() => {
		return d3
			.scaleLinear()
			.domain([0, self.maxPv()])
			.range(yCanvasRange);
	});

/*
	self.yAxis = ko.pureComputed(() => {
		return d3.axisRight().scale(self.yScale());
	});
*/

	self.saturationLine = ko.pureComputed(() => {
		return d3
			.line()
			.x(d => self.xScale()(d.x))
			.y(d => self.yScale()(Math.min(d.y, self.maxPv())));
	});

	self.tempAtCutoff = ko.pureComputed(() => tempFromRhAndPv(1, self.maxPv()));
	self.upperLeftBorderTemp = ko.pureComputed(() => {
		return self.tempAtCutoff() - 0.05 * (self.maxTemp() - self.minTemp());
	});

	self.bottomLeftBorderPv = ko.pureComputed(() => {
		return satPressFromTempIp(self.minTemp()) + 0.05 * self.maxPv();
	});

	self.constantTemps = ko.pureComputed(() => range(self.minTemp(), self.maxTemp(), 1));

	self.constantTempLines = ko.computed(() => {
		return self.constantTemps().map(temp => {
			return [{ x: temp, y: 0 }, { x: temp, y: satPressFromTempIp(temp) }];
		});
	});

	self.TdbColor = ko.observable("#000000", {persist: 'TdbColor'})

	ko.computed(function () {
		var selection = d3.select("#temp-lines")
			.selectAll("path")
			.data(self.constantTempLines());

		selection
			.enter()
				.append("path")
			.merge(selection)
				.attr("d", d => self.saturationLine()(d))
				.attr("fill", "none")
				.attr("stroke", self.TdbColor())
				.attr("stroke-width", d => d[0].x % 5 === 0 ? 1 : 0.5);

		selection.exit().remove();
	});

	self.constantHumiditiesLabels = ko.computed(() => {
		var humidityStep = 0.002;
		var constantHumiditiesLabels = [];
		for (let i = humidityStep; i <= wFromPv(self.maxPv()+0.00001, self.totalPressure()); i = i + humidityStep) {
			constantHumiditiesLabels.push(i);
		}
		return constantHumiditiesLabels;
	});

	self.constantHumiditiesGraph = ko.computed(() => {
		var humidityStep = 0.001;
		// lines at 0.001 spacing with text at 0.002
		var constantHumiditiesGraph = [];
		for (let i = humidityStep; i < wFromPv(self.maxPv(), self.totalPressure()); i = i + humidityStep) {
			constantHumiditiesGraph.push(i);
		}
		return constantHumiditiesGraph;
	});

	self.constantHumidityLines = ko.computed(() => {
		return self.constantHumiditiesGraph().map(humidity => {
			var pv = pvFromw(humidity, self.totalPressure());
			return [
				{
					x: pv < satPressFromTempIp(self.minTemp()) ? self.minTemp() : tempFromRhAndPv(1, pv),
					y: pv
				},
				{ x: self.maxTemp(), y: pv }
			];
		});
	});

	self.WColor = ko.observable("#0000ff", {persist: 'WColor'})

	ko.computed(() => {
		var selection = d3.select("#specific-humidity-lines").selectAll("path").data(self.constantHumidityLines());

		selection.enter()
				.append("path")
				.attr("fill", "none")
				.attr("stroke", self.WColor())
				.attr("stroke-width", 0.5)
			.merge(selection)
				.attr("d", d => self.saturationLine()(d));

		selection.exit().remove();
	});

	self.xAxis = ko.computed(() => {
		return d3
			.axisBottom()
			.scale(self.xScale())
			.tickValues(range(self.minTemp(), self.maxTemp(), 5).filter(temp => temp % 5 === 0));
	});

	ko.computed(() => {
		d3.select("#x-axis").attr("transform", "translate(0," + self.yScale()(-0.005) + ")");

		var axis = self.xAxis();
		d3.select("#x-axis").call(axis);
	});

	self.yAxisHumid = ko.computed(() => {
			return d3
				.axisRight()
				.scale(self.yScale())
				.tickValues(self.constantHumiditiesLabels().map(ω => pvFromw(ω, self.totalPressure())))
				.tickFormat(d => wFromPv(d, self.totalPressure()).toFixed(3));
	});

	ko.computed(() => {
		d3.select("#yAxisHumid")
			.attr("transform", "translate(" + self.xScale()(parseInt(self.maxTemp()) + 0.5) + ",0)")
			.call(self.yAxisHumid());
	});

	// Want the temp diff to be 10% of total width, 9 labels.
	var tempdiff = ko.pureComputed(() => Math.round((self.maxTemp() - self.minTemp()) * 0.15 / 9));
	var starttemp = ko.pureComputed(() => Math.round(self.minTemp() + (self.maxTemp() - self.minTemp()) * 0.6));

	self.constRHLines = ko.computed(() => {
		return constantRHvalues.map((rhValue, i) => {
			const mapFunction = temp => ({
				x: temp,
				y: (satPressFromTempIp(temp) * rhValue) / 100
			});
			var data;
			if (pvFromTempRh(self.maxTemp(), rhValue / 100) < self.maxPv()) {
				data = range(self.minTemp(), self.maxTemp(), 0.5).map(mapFunction);
			} else {
				var tempAtBorder = tempFromRhAndPv(rhValue / 100, self.maxPv());
				data = range(self.minTemp(), tempAtBorder, 0.5).map(mapFunction);
			}

			var temp = starttemp() - i * tempdiff();
			var pv = pvFromTempRh(temp, rhValue / 100);

			//// Get derivative in psia/°F
			var derivative = dPvdT(rhValue / 100, temp);
			//// Need to get in same units, pixel/pixel
			var rotationDegrees = angleFromDerivative(derivative);

			return {
				rh: rhValue,
				temp: temp,
				pv: pv,
				data: data,
				rotationDegrees: rotationDegrees,
				x: self.xScale()(temp),
				y: self.yScale()(pv)
			};
		});
	});

	self.RHColor = ko.observable("#ff0000", {persist: 'RHColor'})

	ko.computed(() => {
		var selection = d3.select("#rh-lines").selectAll("path").data(self.constRHLines());

		selection
			.enter()
				.append("path")
				.attr("fill", "none")
				.attr("stroke", self.RHColor())
				.attr("stroke-width", 1)
			.merge(selection)
				.attr("d", d => self.saturationLine()(d.data));

		selection.exit().remove();

		var height = 12;
		var labelData = self.constRHLines().filter(d => d.pv < self.maxPv());
		selection = d3.select("#rh-label-background").selectAll("rect").data(labelData);
		selection.enter()
				.append("rect")
				.attr("width", 25)
				.attr("height", height)
				.attr("fill", self.BackgroundColor())
			.merge(selection)
				.attr("x", d => self.xScale()(d.temp))
				.attr("y", d => self.yScale()(d.pv))
				.attr("transform", d => `rotate(${d.rotationDegrees}, ${d.x}, ${d.y}) translate(-2 -${height + 2})`);
		selection.exit().remove();

		selection = rhticks.selectAll("text").data(labelData);
		selection.enter()
			.append("text")
				.attr("fill", self.ForegroundColor())
				.style("font-size", "12px")
				.attr("font-family", "sans-serif")
				.attr("class", "rh-ticks")
				.text(d => d.rh + "%")
			.merge(selection)
				.attr("x", d => d.x)
				.attr("y", d => d.y)
				.attr("transform", d => `rotate(${d.rotationDegrees}, ${d.x}, ${d.y}) translate(0 -3)`);
		selection.exit().remove();
	});

	self.minv = ko.computed(() => vFromTempω(self.minTemp(), 0, self.totalPressure()));

	self.maxv = ko.computed(() => vFromTempω(self.maxTemp(), wFromPv(self.maxPv(), self.totalPressure()), self.totalPressure()));
	self.vValues = ko.computed(() => range(Math.ceil(self.minv() / 0.1) * 0.1, Math.floor(self.maxv() / 0.1) * 0.1, 0.1));

	self.vLines = ko.computed(() => {

		var firstVCutoff = vFromTempω(self.minTemp(), satHumidRatioFromTempIp(self.minTemp(), self.totalPressure()), self.totalPressure());
		var secondVCutoff = vFromTempω(self.tempAtCutoff(), wFromPv(self.maxPv(), self.totalPressure()), self.totalPressure());

		return self.vValues().map(v => {
			var mapFunction = temp => { return { x: temp, y: pvFromw(ωFromTempv(temp, v, self.totalPressure()), self.totalPressure()) }; };
			var lowerTemp;
			var upperTemp;

			if (v < firstVCutoff) {
				lowerTemp = self.minTemp();
				upperTemp = tempFromvω(v, 0, self.totalPressure());
			} else if (v < secondVCutoff) {
				lowerTemp = tempPvFromvRh(v, 1, self.totalPressure()).temp;
				upperTemp = Math.min(tempFromvω(v, 0, self.totalPressure()), self.maxTemp());
			} else {
				lowerTemp = tempFromvω(v, wFromPv(self.maxPv(), self.totalPressure()), self.totalPressure());
				upperTemp = Math.min(tempFromvω(v, 0, self.totalPressure()), self.maxTemp());
			}

			var data = [lowerTemp, upperTemp].map(mapFunction);
			var labelLocation = tempPvFromvRh(v, 0.35, self.totalPressure());

			// 144 to go from psf to psi.
			var derivative = -Rda / v / 144;
			var rotationDegrees = angleFromDerivative(derivative);

			return {
				v: Math.round(v * 10) / 10, // properly round to 1 decimal place, because Javascript.
				data: data,
				labelLocation: labelLocation,
				rotationDegrees: rotationDegrees,
				x: self.xScale()(labelLocation.temp),
				y: self.yScale()(labelLocation.pv)
			};
		});
	});

	self.VColor = ko.observable("#800080", {persist: 'VColor'})

	ko.computed(() => {
		var selection = vPaths.selectAll("path").data(self.vLines());
		selection
			.enter()
				.append("path")
				.attr("fill", "none")
				.attr("stroke", self.VColor())
			.merge(selection)
				.attr("d", d => self.saturationLine()(d.data));
		selection.exit().remove();

		var data = self.vLines().filter(d => d.v % 0.5 === 0 &&
			d.labelLocation.temp > self.minTemp() &&
			d.labelLocation.temp < self.maxTemp() &&
			d.labelLocation.pv < self.maxPv());
			
		selection = d3.select("#v-labels").selectAll("text").data(data);
		selection.enter()
				.append("text")
				.attr("class", "ticks")
				.style("font-size", "12px")
				.attr("font-family", "sans-serif")
				.attr("text-anchor", "middle")
			.merge(selection)
			    .text(d => d.v.toFixed(1))
			    .attr("x", d => d.x)
			    .attr("y", d => d.y)
			    .attr("transform", d => `rotate(${d.rotationDegrees}, ${d.x}, ${d.y}) translate(0 -5)`);
		selection.exit().remove();

		selection = d3.select("#v-label-backgrounds").selectAll("rect").data(data);
		selection.enter()
				.append("rect")
				.attr("fill", self.ForegroundColor())
				.attr("width", "25px")
				.attr("height", "15px")
			.merge(selection)
				.attr("x", d => self.xScale()(d.labelLocation.temp))
				.attr("y", d => self.yScale()(d.labelLocation.pv))
				.attr("transform", d => `rotate(${d.rotationDegrees}, ${d.x}, ${d.y}) translate(0 -5) translate(-12 -12)`);
		selection.exit().remove();
	});

	function tempAtStraightEnthalpyLine(enthalpy) {
		var rise = self.maxPv() - self.bottomLeftBorderPv();
		var run = (self.upperLeftBorderTemp()) - self.minTemp();

		function straightLinePv(temp) {
			return self.bottomLeftBorderPv() + (rise / run) * (temp - self.minTemp());
		}

		function funcToZero(temp) {
			return straightLinePv(temp) - pvFromEnthalpyTemp(enthalpy, temp, self.totalPressure());
		}

		// This comes from maxima, a computer algebra system, see corresponding maxima file.
		function derivative(temp) {
			return (rise / run) - ((1807179 * (12000000 * temp - 50000000 * enthalpy) * self.totalPressure()) /
			Math.pow(1807179 * temp + 50000000 * enthalpy + 32994182250, 2) -
			(12000000 * self.totalPressure()) / (1807179 * temp + 50000000 * enthalpy +
													32994182250));
		}

		return newtonRaphson(funcToZero, derivative, 80);
	}

	self.minEnthalpy = ko.pureComputed(() => enthalpyFromTempPv(self.minTemp(), 0, self.totalPressure()));
	self.maxEnthalpy = ko.pureComputed(() => {
		return enthalpyFromTempPv(self.maxTemp(), self.maxPv(), self.totalPressure());
	});

	self.constEnthalpyValues = ko.computed(() => {
		var ValArray = range(Math.ceil(self.minEnthalpy()), Math.floor(self.maxEnthalpy()), 0.2);

		// From array of all possible Enthalpy value - remove unused
		ValArray.splice(0, 1); // 1st item in twice 
		// Clean up range for lower edge to allow entralpy scale - kludge
		var firstBoundaryEnthalpy = enthalpyFromTempPv(self.minTemp(), satPressFromTempIp(self.minTemp()), self.totalPressure());

		for (var i = 0; i < ValArray.length; i++)
		{
			if (ValArray[i] < firstBoundaryEnthalpy && ValArray[i] % 1 != 0)
			{
				ValArray.splice(i, 1);
				i--;
			}
		}
		return ValArray;
	});

	self.enthalpyValueToLine = enthalpyValue => {

		var firstBoundaryEnthalpy = enthalpyFromTempPv(self.minTemp(), satPressFromTempIp(self.minTemp()) + 0.05 * self.maxPv(), self.totalPressure());

		var secondBoundaryEnthalpy = enthalpyFromTempPv(self.upperLeftBorderTemp(), self.maxPv(), self.totalPressure());

		var maxEnthalpyTemp = Math.min(enthalpyValue / 0.24, self.maxTemp());

		var mapFunction = temp => { return { x: temp, y: pvFromEnthalpyTemp(enthalpyValue, temp, self.totalPressure()) }; };

		if (enthalpyValue < firstBoundaryEnthalpy) {
			if (enthalpyValue % 1 === 0) {
				return { h: enthalpyValue, coords: range(self.minTemp(), maxEnthalpyTemp, 0).map(mapFunction) };
			} else {
				return { h: enthalpyValue, coords: range(self.minTemp(), satTempAtEnthalpy(enthalpyValue, self.totalPressure()), 0).map(mapFunction) };
			}
		} else if (enthalpyValue < secondBoundaryEnthalpy) {
			var tempAtBorder = tempAtStraightEnthalpyLine(enthalpyValue);
			return { h: enthalpyValue, coords: range(tempAtBorder, enthalpyValue % 1 === 0 ? maxEnthalpyTemp : satTempAtEnthalpy(enthalpyValue, self.totalPressure()), 0).map(mapFunction) };
		} else { // Top section
			return { h: enthalpyValue,
				coords: range(tempFromEnthalpyPv(enthalpyValue, self.maxPv(), self.totalPressure()),
					isMult(enthalpyValue, 1) ? maxEnthalpyTemp : satTempAtEnthalpy(enthalpyValue, self.totalPressure()), 0).map(mapFunction)
			};
		}
	};

	self.constEnthalpyLines = ko.computed(() => self.constEnthalpyValues().map(self.enthalpyValueToLine));

	self.HColor = ko.observable("#008000", {persist: 'HColor'})

	// Draw enthalpy items.
	ko.computed(() => {

		var selection = enthalpyPaths;
		selection.selectAll("path").remove();

		selection = enthalpyPaths
			.selectAll("path")
			.data(self.constEnthalpyLines());

		selection.enter()
			.append("path")
			.attr("fill", "none")
			.attr("stroke", self.HColor())
			.attr("stroke-width", d => {
				if (d.h % 5 === 0) {
					return 1.2;
				} if (d.h % 1 === 0) {
					return 0.6;
				}
				return 0.25;
			})
			.attr("d", d => self.saturationLine()(d.coords));

	// Enthalpy scale text
		var data = self.constEnthalpyValues().filter(h =>
			h % 5 === 0 &&
			h < enthalpyFromTempPv(self.upperLeftBorderTemp(), self.maxPv(), self.totalPressure())
		);

		selection = hLabels.selectAll("text").data(data);
		selection.enter()
				.append("text")
				.attr("class", "ticks")
				.style("font-size", "10px")
				.attr("font-family", "sans-serif")
				.text(d => d.toString())
			.merge(selection)
				.attr("x", h => self.xScale()(tempAtStraightEnthalpyLine(h) - 0.75))
				.attr("y", h => self.yScale()(pvFromEnthalpyTemp(h, tempAtStraightEnthalpyLine(h), self.totalPressure()) + 0.005));
		selection.exit().remove();
	});

	self.minWetBulb = ko.computed(() => wetBulbFromTempω(self.minTemp(), 0, self.totalPressure()));
	self.maxWetBulb = ko.computed(() => wetBulbFromTempω(self.maxTemp(), wFromPv(self.maxPv(), self.totalPressure()), self.totalPressure()));
	self.wetBulbBottomRight = ko.computed(() => wetBulbFromTempω(self.maxTemp(), 0, self.totalPressure()));
	self.wetBulbValues = ko.computed(() => range(Math.ceil(self.minWetBulb()), Math.floor(self.maxWetBulb()), 1));

	var wetBulbLabelRh = 0.55; // RH value to put all the wetbulb labels.
	self.wetBulbLines = ko.computed(() => {

		// This is the derivative of Pv vs. temperature for 
		// a given constant wet-bulb line.
		derivative = (temp, wetbulb) => {
			var wsatwetbulb = satHumidRatioFromTempIp(wetbulb, self.totalPressure())

			var high = (1093 - 0.556*wetbulb) * wsatwetbulb - 0.24 * (temp - wetbulb);
			var low = 1093 + 0.444 * temp - wetbulb;

			var dHigh = -0.24;
			var dLow = 0.444;

			var dwdT = ((low * dHigh) - (high * dLow)) / (low * low);

			var w = ωFromWetbulbDryBulb(wetbulb, temp, self.totalPressure());

			var dpvdw = (200000*self.totalPressure())/(200000*w+124389)-(40000000000*self.totalPressure()*w)/Math.pow(200000*w+124389,2);

			return dpvdw * dwdT;
		}

		return self.wetBulbValues().map((wetbulbTemp) => {
			var mapFunction = temp => {
				return {
					y: pvFromw(ωFromWetbulbDryBulb(wetbulbTemp, temp, self.totalPressure()), self.totalPressure()),
					x: temp
				};
			};

			var lowerTemp;
			var upperTemp;
			if (wetbulbTemp < self.minTemp()) {
				lowerTemp = self.minTemp();
				upperTemp = tempFromWetbulbω(wetbulbTemp, 0, self.totalPressure());
			} else if (wetbulbTemp < self.wetBulbBottomRight()) {
				lowerTemp = wetbulbTemp;
				upperTemp = tempFromWetbulbω(wetbulbTemp, 0, self.totalPressure());
			} else if (wetbulbTemp < self.tempAtCutoff()) {
				lowerTemp = wetbulbTemp;
				upperTemp = self.maxTemp();
			} else {
				lowerTemp = tempFromWetbulbω(wetbulbTemp, wFromPv(self.maxPv(), self.totalPressure()), self.totalPressure());
				upperTemp = self.maxTemp();
			}

			var data = range(lowerTemp, upperTemp, 3).map(mapFunction);
			var labelState = WetBulbRh(wetbulbTemp, wetBulbLabelRh, self.totalPressure());
			var midtemp = labelState.temp;
			var rotationAngle = angleFromDerivative(derivative(midtemp, wetbulbTemp));
			var midpv = labelState.pv;

			return {
				wetbulbTemp: wetbulbTemp,
				data: data,
				midtemp: midtemp,
				midpv: midpv,
				x: self.xScale()(midtemp),
				y: self.yScale()(midpv),
				rotationAngle: rotationAngle
			};
		});
	});

	self.TwbColor = ko.observable("#ffa500", {persist: 'TwbColor'})

	// Drawing wet-bulb items.
	ko.computed(() => {
		var selection = wetBulbPaths.selectAll("path").data(self.wetBulbLines());
		selection.enter().append("path")
				.attr("fill", "none")
				.attr("stroke", self.TwbColor())
				.attr("stroke-dasharray", "4 1")
				.attr("stroke-width", d => {
						if (d.wetbulbTemp % 5 === 0) {
							return 1;
						}
						return 0.5;
					})
			.merge(selection)
				.attr("d", d => self.saturationLine()(d.data));
		selection.exit().remove();

		// Wet-bulb data
		var data = self.wetBulbLines().filter(d => d.wetbulbTemp % 5 === 0 && d.midtemp > minTemp && d.midtemp < self.maxTemp() && d.midpv < self.maxPv());
		selection = d3.select("#wetbulb-labels").selectAll("text").data(data);
		selection.enter()
				.append("text")
				.attr("class", "ticks")
				.style("font-size", "8px")
				.attr("font-family", "sans-serif")
				.text(d => d.wetbulbTemp.toFixed(0))
			.merge(selection)
				.attr("x", d => self.xScale()(d.midtemp))
				.attr("y", d => self.yScale()(d.midpv))
				.attr("transform", d => `rotate(${d.rotationAngle}, ${d.x}, ${d.y}) translate(0 -3)`);
		selection.exit().remove();

		selection = d3.select("#wetbulb-labels-backgrounds").selectAll("rect").data(data);
		selection.enter()
				.append("rect")
				.attr("fill", self.ForegroundColor())
				.attr("width", "14px")
				.attr("height", "10px")
			.merge(selection)
				.attr("x", d => self.xScale()(d.midtemp))
				.attr("y", d => self.yScale()(d.midpv))
				.attr("transform", d => `rotate(${d.rotationAngle}, ${d.x}, ${d.y}) translate(0 -3) translate(-2 -8)`);
		selection.exit().remove();
	});

	self.boundaryLineData = ko.computed(() => {
		return [
			{ x: self.maxTemp(), y: 0 },
			{ x: self.minTemp(), y: 0 },
			{ x: self.minTemp(), y: satPressFromTempIp(self.minTemp()) },
			...range(self.minTemp(), tempFromRhAndPv(1, self.maxPv()), 0.1).map((temp) => { return { x: temp, y: satPressFromTempIp(temp) }; }),
			{ x: tempFromRhAndPv(1, self.maxPv()), y: self.maxPv() },
			{ x: self.maxTemp(), y: satPressFromTempIp(tempFromRhAndPv(1, self.maxPv())) },
			{ x: self.maxTemp(), y: 0 }
		];
	});

	ko.computed(() => {
		d3.select("#boundary-lines").select("path")
			.attr("d", self.saturationLine()(self.boundaryLineData()) + " Z");
	});

	ko.computed(() => {
		enthalpyBorderPath
			.attr(
				"d",
				self.saturationLine()([
					{ x: self.minTemp(), y: satPressFromTempIp(self.minTemp()) },
					{ x: self.minTemp(), y: self.bottomLeftBorderPv() },
					{ x: self.upperLeftBorderTemp(), y: self.maxPv() },
					{ x: self.tempAtCutoff(), y: self.maxPv() }
				])

			)
			.attr("fill", "none")
			.attr("stroke", self.ForegroundColor())
			.attr("stroke-width", 2);
			//.call(boundaryLine);
	});

	self.summerComfortZoneData = ko.computed(() => {
		return [
			{ x: 74, y: 0.0044 },
			{ x: 81, y: 0.0044 },
			{ x: 79, y: 0.0122 },
			{ x: 73, y: 0.0136 }
		];
	});
	
var lineGenerator = d3.line();

    ko.computed(() => {
		d3.select("#summerComfortZone").select("path")
			.attr("d", d => self.summerComfortZoneData()(d.coords));
	});


	self.states = ko.observableArray([new StateTempω(self.maxTemp(), self.maxω(), "State 1", self.totalPressure(), self.altitudeInput(), 0)]);

	if (urlParams["Tdb2"] != null)
		self.states.push(
			new StateTempω(self.maxTemp(), self.maxω(), "State " + (self.states().length + 1), self.totalPressure(), self.altitudeInput(), self.states().length)
		);
	if (urlParams["Tdb3"] != null)
		self.states.push(
			new StateTempω(self.maxTemp(), self.maxω(), "State " + (self.states().length + 1), self.totalPressure(), self.altitudeInput(), self.states().length)
		);

	self.addState = () => {
		self.states.push(
			new StateTempω(self.maxTemp(), self.maxω(), "State " + (self.states().length + 1), self.totalPressure(), self.altitudeInput(), self.states().length)
		);
	};

	self.removeState = (state) => { self.states.remove(state); };

	self.StateColor = ko.observable("#ff0000", {persist: 'StateColor'})

	ko.computed(() => {
		var rightOffset = 10;

		var selection = d3.select("#state-text").selectAll("text").data(self.states());
		selection.enter()
				.append("text")
				.attr("fill", self.ForegroundColor())
				.attr("font-family", "sans-serif")
			.merge(selection)
				.attr("x", d => self.xScale()(d.Tdb()))
				.attr("y", d => self.yScale()(d.pv()))
				.attr("dx", rightOffset)
				.attr("dy", "-10")
				.text((d, i) => d.name());
		selection.exit().remove();

		// Once the text has been created we can get the size
		// of the bounding box to put the background behind.
		var boundingBoxes = [];
		d3.select("#state-text").selectAll("text").each(function (d, i) {
			boundingBoxes[i] = this.getBoundingClientRect();
		});

		selection = d3.select("#state-backgrounds").selectAll("rect").data(self.states());
		selection.enter()
				.append("rect")
				.attr("height", "20px")
				.attr("fill", self.BackgroundColor())
			.merge(selection)
				.attr("x", d => self.xScale()(d.Tdb()))
				.attr("y", d => self.yScale()(d.pv()))
				.attr("transform", (d, i) => `translate(${rightOffset - Math.round(boundingBoxes[i].width * 0.1 / 2)}, -25)`)
				.attr("width", (d, i) => `${Math.ceil(boundingBoxes[i].width * 1.1)}px`);
		selection.exit().remove();

		selection = d3.select("#state-circles").selectAll("circle").data(self.states());
		selection.enter()
				.append("circle")
				.attr("fill", self.StateColor())
				.attr("r", "5")
			.merge(selection)
				.attr("cx", d => self.xScale()(d.Tdb()))
				.attr("cy", d => self.yScale()(d.pv()));
		selection.exit().remove();
	});

	var pvAxisTemp = self.maxTemp() + 6;

   ko.computed(() => {
	yAxisSelection
		.attr("transform", "translate(" + self.xScale()(pvAxisTemp) + ",0)")
		.call(d3.axisRight().scale(self.yScale()));
	});

	self.xAxisLabel = ko.observable("Dry bulb temperature / °F", {persist: 'X-AxisLabel'})
	self.humidityLabel = ko.observable("ω", {persist: 'HumidityLabel'})
	self.yAxisLabel = ko.observable("Vapor Pressure / psia", {persist: 'Y-AxisLabel'})

   ko.computed(() => {
	// X-axis label
		selection = d3.select("#tdb-label").selectAll("text").data([null]);
		selection.enter()
			.append("text")
			.style("font-size", "16px")
			.attr("font-family", "sans-serif")
			.attr("fill", self.ForegroundColor())
			.attr("text-anchor", "middle")
		.merge(selection)
			.text(self.xAxisLabel())
			.attr("x", self.xScale()((self.maxTemp() + self.minTemp()) / 2))
			.attr("y", self.yScale()(-0.05));
		selection.exit().remove();

	// ω label
		selection = d3.select("#humidity-label").selectAll("text").data([null]);
		selection.enter()
			.append("text")
			.style("font-size", "16px")
			.attr("font-family", "sans-serif")
			.attr("fill", self.ForegroundColor())
		.merge(selection)
			.text(self.humidityLabel())
			.attr("x", self.xScale()(self.maxTemp() + 4))
			.attr("y", self.yScale()(self.maxPv() / 2));
		selection.exit().remove();

		// Y--axis label
		var pvAxisX = self.xScale()(pvAxisTemp + 5);
		var pvAxisY = self.yScale()(self.maxPv() / 2);

		selection = d3.select("#vaporPressure-label").selectAll("text").data([null]);
		selection.enter()
			.append("text")
			.style("font-size", "16px")
			.attr("font-family", "sans-serif")
			.attr("fill", self.ForegroundColor())
			.attr("text-anchor", "middle")
		.merge(selection)
			.text(self.yAxisLabel())
			.attr("x", pvAxisX)
			.attr("y", pvAxisY)
			.attr("transform", `rotate(-90, ${pvAxisX}, ${pvAxisY})`);
		selection.exit().remove();
	});

	self.enthalpyLabel = ko.observable("Enthalpy / Btu per lb d.a.", {persist: 'EnthalpyLabel'})

	// Main enthalpy axis label
	ko.computed(() => {
		var rise = self.maxPv() - self.bottomLeftBorderPv();
		var run = self.upperLeftBorderTemp() - self.minTemp();

		var angle = Math.atan((rise * self.pixelsPerPsia()) / (run * self.pixelsPerTemp())) * 180 / Math.PI;

		var basex = (self.upperLeftBorderTemp() + self.minTemp()) / 2;
		var basey = (self.maxPv() + self.bottomLeftBorderPv()) / 2;

		var absBasex = self.xScale()(basex)
		var absBasey = self.yScale()(basey)

		selection = d3.select("#enthalpy-label").selectAll("text").data([null]);
		selection.enter()
			.append("text")
			.style("font-size", "16px")
			.attr("font-family", "sans-serif")
			.attr("fill", self.ForegroundColor())
			.attr("text-anchor", "middle")
		.merge(selection)
			.text(self.enthalpyLabel())
			.attr("x", absBasex)
			.attr("y", absBasey)
			.attr("transform", `rotate(${angle}, ${absBasex}, ${absBasey}) translate(-100 -40)`);
		selection.exit().remove();
	});

	// Temp on 100% humidity line
	ko.computed(() => {
		var data = self.constantTemps().filter(temp => temp % 5 === 0 && satPressFromTempIp(temp) < self.maxPv());

		var selection = d3.selectAll("#dewpointlabels");
		selection.selectAll("text").remove();
		
		selection = d3.selectAll("#dewpoint-backgrounds");
		selection.selectAll("rect").remove();

		selection = d3.selectAll("#dewpointlabels")
			.selectAll("text")
			.data(data);

		selection.enter()
			.append("text")
			.text(d => d.toString())
			.style("fill", self.ForegroundColor())
			.attr("dx", "-13")
			.attr("font-size", "10px")
			.attr("font-family", "sans-serif")
			.attr("x", d => self.xScale()(d))
			.attr("y", d => self.yScale()(satPressFromTempIp(d) + 0.003));
			
			selection = d3.selectAll("#dewpoint-backgrounds")
			.selectAll("rect")
			.data(data);

		selection.enter()
			.append("rect")
			.attr("fill", self.BackgroundColor())
			.attr("width", "14px")
			.attr("height", "10px")
			.attr("x", d => self.xScale()(d)-14)
			.attr("y", d => self.yScale()(satPressFromTempIp(d) + 0.012));
	});


//	Protractor
	var selection = d3.selectAll("#protractor");
		selection.append("path")
		.attr("transform", "translate(200,50)")
		.attr("d", arcGenerator());

	var innerText = [[1, 0], [2, 16.8], [4, 24.5], [8, 28], 
	 [Infinity, 31.3], [-8, 33.4], [-4, 37.3], [-2, 42.5], 
	 [-1, 50.9], [-0.5, 61.7], [-0.4, 65.3], [-0.3, 69.8], 
	 [-0.2, 75.3], [-0.1, 82.3], [0, 91], [0.1, 101.3], 
	 [0.2, 113.2], [0.3, 126.1], [0.4, 138.4], [0.5, 149.1], 
	 [0.6, 158.2], [0.8, 170.5], [1, 180]];

	var outerText = [[-Infinity, 0], [-2000, 13], [-1000, 18.4], [0, 31.3], [500, 49.1], [1000, 83.7], [1500, 123.5], [2000, 145.6], [3000, 162.2], [5000, 170.5], [Infinity, 180]];

	var path1 = [0, 16.8, 24.5, 28, 31.3, 33.4, 37.3, 42.5,  50.9, 61.7, 65.3, 69.8, 75.3, 82.3, 91, 101.3, 113.2, 126.1, 138.4, 149.1, 158.2, 170.5, 180];
	var path2 = [15.2, 33.5, 37.3, 40.8, 44.6, 54.3, 60.5, 67.3, 75.2, 92.3, 101.1, 109.3, 116.9, 129.4, 134.4, 138.7, 142.3, 156.3, 168.4]; 
	var path3 = [0, 13, 18.4, 31.3, 49.1, 83.7, 123.5, 145.6, 162.2, 170.5, 180]; 

	var test = "";
	let i = 0;
	let d = 0;
	let xx = 200;
	let yy = 50;
	while (i < path1.length) {
			let s = 10;
			d = path1[i] / 180*Math.PI;
			let x = Math.cos(d)
			let y = Math.max(Math.sin(d),0.0001)
			let r = radius;
			test += `M${Math.round((x*r+xx)*10)/10} ${Math.round((y*r+yy)*10)/10}L${Math.round((x*(r-s)+xx)*10)/10} ${Math.round((y*(r-s)+yy)*10)/10}`;
		 i++;
	}
	test += `Z`;

	selection.append("path")
	.attr("stroke", "blue")
	.attr("d",test);
	
	selection.selectAll("#path2.tick")
	.data(path2)
	.enter()
	.append("path")
	.classed("tick", true)
	.attr("transform", "translate(200,50)")
	.attr("stroke", "red")
	
	.attr("d", d => {
		let s = 5;
		d = d / 180*Math.PI;
		let x = Math.cos(d)
		let y = Math.max(Math.sin(d),0.0001)
		let r = radius;
		return 		`M${Math.round(x*r*10)/10},${Math.round(y*r*10)/10}L${Math.round(x*(r+s)*10)/10},${Math.round(y*(r+s)*10)/10}`;
	})

	selection.selectAll("#path3.tick")
	.data(path3)
	.enter()
	.append("path")
	.classed("tick", true)
	.attr("transform", "translate(200,50)")
	.attr("stroke", "black")
	
	.attr("d", d => {
		let s = 10;
		d = d / 180*Math.PI;
		let x = Math.cos(d)
		let y = Math.max(Math.sin(d),0.0001)
		let r = radius;
		return `M${Math.round(x*r*10)/10},${Math.round(y*r*10)/10}L${Math.round(x*(r+s)*10)/10},${Math.round(y*(r+s)*10)/10}`;


	})

	self.previousColors = ko.observableArray(['#ff0000', '#ff0000', '#008000', '#ffa500', '#800080', '#000000', '#0000ff', '#000000', '#ffffff'], {persist: 'PreviousColors'})

	//Set href value of element
	self.selected = ko.observable(null);
	
	//initial set to show first tabpanel when loading page
	self.init = ko.observable(1);

	//Get href value og element
	self.getHref = function(){
		var target;
		var element = event.target.hash;
		target = element.substr(1);
		return target;
	};

	//Show Tabpanel
	self.showBlock = function(){
		var target = self.getHref();
		self.selected(target);
		self.init(2);
		if (target === 'tab3')		// Save colors coming into Tab
		{
			self.previousColors.replace(self.previousColors()[0], self.StateColor());
			self.previousColors.replace(self.previousColors()[1], self.RHColor());
			self.previousColors.replace(self.previousColors()[2], self.HColor());
			self.previousColors.replace(self.previousColors()[3], self.TwbColor());
			self.previousColors.replace(self.previousColors()[4], self.VColor());
			self.previousColors.replace(self.previousColors()[5], self.TdbColor());
			self.previousColors.replace(self.previousColors()[6], self.WColor());
			self.previousColors.replace(self.previousColors()[7], self.ForegroundColor());
			self.previousColors.replace(self.previousColors()[8], self.BackgroundColor());
		}
	};

	self.user1Colors = ko.observableArray(['#ff0000', '#ff0000', '#008000', '#ffa500', '#800080', '#000000', '#0000ff', '#000000', '#ffffff'], {persist: 'User1Colors'})
	self.user2Colors = ko.observableArray(['#ff0000', '#ff0000', '#008000', '#ffa500', '#800080', '#000000', '#0000ff', '#000000', '#ffffff'], {persist: 'User2Colors'})
	self.user3Colors = ko.observableArray(['#ff0000', '#ff0000', '#008000', '#ffa500', '#800080', '#000000', '#0000ff', '#000000', '#ffffff'], {persist: 'User3Colors'})

	self.user1Color = ko.observable(false, {persist: 'User1Color'})
	self.user2Color = ko.observable(false, {persist: 'User2Color'})
	self.user3Color = ko.observable(false, {persist: 'User3Color'})

	// If any color changes update chart
	ko.computed(() => {
	  d3.selectAll('#state-circles').selectAll('circle').attr('fill', self.StateColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[0], self.StateColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[0], self.StateColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[0], self.StateColor());
  
	  d3.selectAll('#state-text').selectAll('text').attr('fill', self.ForegroundColor());

	  d3.selectAll('#rh-lines').selectAll('path').attr('stroke', self.RHColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[1], self.RHColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[1], self.RHColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[1], self.RHColor());

	  d3.selectAll('#enthalpyLines').selectAll('path').attr('stroke', self.HColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[2], self.HColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[2], self.HColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[2], self.HColor());

	  d3.selectAll('#wetbulb-lines').selectAll('path').attr('stroke', self.TwbColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[3], self.TwbColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[3], self.TwbColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[3], self.TwbColor());

	  d3.selectAll('#vpaths').selectAll('path').attr('stroke', self.VColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[4], self.VColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[4], self.VColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[4], self.VColor());

	  d3.selectAll('#temp-lines').selectAll('path').attr('stroke', self.TdbColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[5], self.TdbColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[5], self.TdbColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[5], self.TdbColor());

	  d3.selectAll('#specific-humidity-lines').selectAll('path').attr('stroke', self.WColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[6], self.WColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[6], self.WColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[6], self.WColor());

	  d3.selectAll('#boundary-lines').selectAll('path').attr('stroke', self.ForegroundColor());
	  d3.selectAll('#x-axis').selectAll('path').attr('stroke', self.ForegroundColor());
	  d3.selectAll('#x-axis').selectAll('line').attr('stroke', self.ForegroundColor());
	  d3.selectAll('#x-axis').selectAll('text').attr('fill', self.ForegroundColor());
	  d3.selectAll('#yAxisHumid').selectAll('path').attr('stroke', self.ForegroundColor());
	  d3.selectAll('#yAxisHumid').selectAll('line').attr('stroke', self.ForegroundColor());
	  d3.selectAll('#yAxisHumid').selectAll('text').attr('fill', self.ForegroundColor());
	  d3.selectAll('#yAxis').selectAll('path').attr('stroke', self.ForegroundColor());
	  d3.selectAll('#yAxis').selectAll('line').attr('stroke', self.ForegroundColor());
	  d3.selectAll('#yAxis').selectAll('text').attr('fill', self.ForegroundColor());
	  d3.selectAll('text').attr('fill', self.ForegroundColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[7], self.ForegroundColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[7], self.ForegroundColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[7], self.ForegroundColor());

	  d3.selectAll('rect').attr('fill', self.BackgroundColor());
	  if (!self.user1Color())
			self.user1Colors.replace(self.user1Colors()[8], self.BackgroundColor());
	  if (!self.user2Color())
			self.user2Colors.replace(self.user2Colors()[8], self.BackgroundColor());
	  if (!self.user3Color())
			self.user3Colors.replace(self.user3Colors()[8], self.BackgroundColor());
	});

	// Checkboxes for Output + Local storage

	// Observable with initial value and localStorage Persistence
	self.PsychometricOutput = ko.observable('7', {persist: 'PsychometricOutput'})
		
	self.Items = [
		{ Name: 'Label', 
			IsChecked: ko.observable((self.PsychometricOutput() & 1) != 0)},
		{ Name: '% Relative Humidity', 
			IsChecked: ko.observable((self.PsychometricOutput() & 2) != 0)},
		{ Name: 'Dry Bulb Temperature', 
			IsChecked: ko.observable((self.PsychometricOutput() & 4) != 0)},
		{ Name: 'Wet Bulb Temperature', 
			IsChecked: ko.observable((self.PsychometricOutput() & 8) != 0)},
		{ Name: 'Dewpoint Temperature', 
			IsChecked: ko.observable((self.PsychometricOutput() & 16) != 0)},
		{ Name: 'Enthalpy', 
			IsChecked: ko.observable((self.PsychometricOutput() & 32) != 0)},
		{ Name: 'Humidity Ratio', 
			IsChecked: ko.observable((self.PsychometricOutput() & 64) != 0)},
		{ Name: 'Moist Air Specific Volume', 
			IsChecked: ko.observable((self.PsychometricOutput() & 128) != 0)},
		{ Name: 'Vapor Pressure', 
			IsChecked: ko.observable((self.PsychometricOutput() & 256) != 0)},
		{ Name: 'Test', 		// for debugging
			IsChecked: ko.observable((self.PsychometricOutput() & 512) != 0)}
	];

	// logic to keep the All checkbox correct
	self.AllChecked = ko.computed({
        read: function() {
            var firstUnchecked = ko.utils.arrayFirst(self.Items, function(item) {
                return item.IsChecked() == false;
            });
            return firstUnchecked == null;
        },
        write: function(value) {
            ko.utils.arrayForEach(self.Items, function(item) {
                item.IsChecked(value);
            });
        }
    });

	// If any checkboxes change, update local storage
	ko.computed(function () {
		var tmp = 0;
		ko.utils.arrayForEach(self.Items, function(item, index) {
			tmp |= Number(item.IsChecked()) << index;
		});
		self.PsychometricOutput(tmp);
	});

	var elementObservables = [
		{ obs: "showEnthalpyLines", ids: ["enthalpyLines", "enthalpy-border", "enthalpy-label", "h-labels"] },
		{ obs: "showvLines", ids: ["vpaths","v-label-backgrounds", "v-labels"] },
		{ obs: "showWetBulb", ids: ["wetbulb-lines", "wetbulb-labels", "wetbulb-labels-backgrounds"] },
		{ obs: "showDryBulb", ids: ["temp-lines"] },
		{ obs: "showω", ids: ["specific-humidity-lines"] },
		{ obs: "showRH", ids: ["rh-lines", "rh-ticks", "rh-label-background"] },
		{ obs: "showVP", ids: ["yAxis", "vaporPressure-label"] },
		{ obs: "showProtractor", ids: ["protractor"] }
	];

	// Observable with initial value and localStorage Persistence
	self.PsychometricShow = ko.observable('7', {persist: 'PsychometricShow'})

	elementObservables.map(o => {
		var Show = Number(self.PsychometricShow());

		if (o.obs === "showRH" && Show & 1 || 
			 o.obs === "showω" && Show & 2 || 
			 o.obs === "showDryBulb" && Show & 4 || 
			 o.obs === "showWetBulb" && Show & 8 || 
			 o.obs === "showvLines" && Show & 16 || 
			 o.obs === "showEnthalpyLines" && Show & 32 ||
			 o.obs === "showVP" && Show & 64 ||
			 o.obs === "showProtractor" && Show & 128) 
			self[o.obs] = ko.observable(true);
		else
			self[o.obs] = ko.observable(false);

		ko.computed(() => {
			var Show = self.PsychometricShow();
			for (let i = 0; i < o.ids.length; i++) {
				var element = document.getElementById(o.ids[i]);

				if (element) {
					element.style.visibility = self[o.obs]()
						? "visible"
						: "hidden";

				// Works but big kludge
				if (o.obs === "showRH")
					if (element.style.visibility === "visible")
						Show |= 1;
					else
						Show &= 0b11111110;
				else if (o.obs === "showω")
					if (element.style.visibility === "visible")
						Show |= 2;
					else
						Show &= 0b11111101;
				else if (o.obs === "showDryBulb")
					if (element.style.visibility === "visible")
						Show |= 4;
					else
						Show &= 0b11111011;
				else if (o.obs === "showWetBulb")
					if (element.style.visibility === "visible")
						Show |= 8;
					else
						Show &= 0b11110111;
				else if (o.obs === "showvLines")
					if (element.style.visibility === "visible")
						Show |= 16;
					else
						Show &= 0b11101111;
				else if (o.obs === "showEnthalpyLines")
					if (element.style.visibility === "visible")
						Show |= 32;
					else
						Show &= 0b11011111;
				else if (o.obs === "showVP")
					if (element.style.visibility === "visible")
						Show |= 64;
					else
						Show &= 0b10111111;
				else if (o.obs === "showProtractor")
					if (element.style.visibility === "visible")
						Show |= 128;
					else
						Show &= 0b01111111;
				}
			}
			self.PsychometricShow(Show);
		});
	});


	self.blobUrl = ko.pureComputed(() => {
		var blob = new Blob([d3.select("#vizcontainer").node().innerHTML], { type: "image/svg+xml" });
		return URL.createObjectURL(blob);
	});

	self.savePng = () => saveSvgAsPng(document.getElementById("chartsvg"), "chart.png", { backgroundColor: "white" });

	self.saveSvg = () => saveSvg(document.getElementById("chartsvg"), 'chart.svg');

	ko.bindingHandlers.option = {
		 update: function(element, valueAccessor) {
			 var value = ko.utils.unwrapObservable(valueAccessor());
			 ko.selectExtensions.writeValue(element, value);   
		 }        
	};
}

//https://github.com/jimrhoskins/knockout.localStorage/blob/master/knockout.localStorage.js
(function(ko){
  // Wrap ko.observable and ko.observableArray
  var methods = ['observable', 'observableArray'];

  ko.utils.arrayForEach(methods, function(method){
    var saved = ko[method];
    
    ko[method] = function(initialValue, options){
      options = options || {};

      var key = options.persist;

      // Load existing value if set
      if(key && localStorage.hasOwnProperty(key)){
        try{
          initialValue = JSON.parse(localStorage.getItem(key))
        }catch(e){};
      }

      // Create observable from saved method
      var observable = saved(initialValue);

      // Subscribe to changes, and save to localStorage
      if(key){
        observable.subscribe(function(newValue){
          localStorage.setItem(key, ko.toJSON(newValue));
        });
      };

      return observable;
    }
  })
})(ko);

var urlParams;

(window.onpopstate = function () {
	 var match,
		  pl     = /\+/g,  // Regex for replacing addition symbol with a space
		  search = /([^&=]+)=?([^&]*)/g,
		  decode = function (s) { return decodeURIComponent(s.replace(pl, " ")); },
		  query  = window.location.search.substring(1);
  
	 urlParams = {};
	 while (match = search.exec(query))
		 urlParams[decode(match[1])] = decode(match[2]);
})();

var viewModel = new ViewModel();
ko.applyBindings(viewModel);

const defaultColors = ["#ff0000", "#ff0000", "#008000", "#ffa500", "#800080", "#000000", "#0000ff", "#000000", "#ffffff"]

const cooleradoColors = ["#ff0000", "#f68712", "#2c2829", "#951c21", "#4d45a4", "#2c2829", "#7a7b7c", "#000000", "#ffffff"]

const colerBrewerColors = ["#e41a1c", "#984ea3", "#377eb8", "#ff7f00", "#4daf4a", "#999999", "#999999", "#000000", "#ffffff"]

const colorBlindColors = ["#cc3311", "#009988", "#ee7733", "#0077bb", "#33bbee", "#ee3377", "#bbbbbb", "#000000", "#ffffff"]

const bwColors = ["#000000", "#000000", "#000000", "#000000", "#000000", "#000000", "#000000", "#000000", "#ffffff"]

const TrubetskoyColors = ["#000075", "#4363d8", "#dcbeff", "#ffe119", "#f58231", "#a9a9a9", "#a9a9a9", "#000000", "#ffffff"]


function setColors(colorList) {
	viewModel.StateColor(colorList[0]);
	viewModel.RHColor(colorList[1]);
	viewModel.HColor(colorList[2]);
	viewModel.TwbColor(colorList[3]);
	viewModel.VColor(colorList[4]);
	viewModel.TdbColor(colorList[5]);
	viewModel.WColor(colorList[6]);
	viewModel.ForegroundColor(colorList[7]);
	viewModel.BackgroundColor(colorList[8]);
}

// kludge - cannot figure out how to pass observableArray to function
function setPreviousColors() {
	viewModel.StateColor(viewModel.previousColors()[0]);
	viewModel.RHColor(viewModel.previousColors()[1]);
	viewModel.HColor(viewModel.previousColors()[2]);
	viewModel.TwbColor(viewModel.previousColors()[3]);
	viewModel.VColor(viewModel.previousColors()[4]);
	viewModel.TdbColor(viewModel.previousColors()[5]);
	viewModel.WColor(viewModel.previousColors()[6]);
	viewModel.ForegroundColor(viewModel.previousColors()[7]);
	viewModel.BackgroundColor(viewModel.previousColors()[8]);
}


function setUser1Colors() {
	viewModel.StateColor(viewModel.user1Colors()[0]);
	viewModel.RHColor(viewModel.user1Colors()[1]);
	viewModel.HColor(viewModel.user1Colors()[2]);
	viewModel.TwbColor(viewModel.user1Colors()[3]);
	viewModel.VColor(viewModel.user1Colors()[4]);
	viewModel.TdbColor(viewModel.user1Colors()[5]);
	viewModel.WColor(viewModel.user1Colors()[6]);
	viewModel.ForegroundColor(viewModel.user1Colors()[7]);
	viewModel.BackgroundColor(viewModel.user1Colors()[8]);
}

function setUser2Colors() {
	viewModel.StateColor(viewModel.user2Colors()[0]);
	viewModel.RHColor(viewModel.user2Colors()[1]);
	viewModel.HColor(viewModel.user2Colors()[2]);
	viewModel.TwbColor(viewModel.user2Colors()[3]);
	viewModel.VColor(viewModel.user2Colors()[4]);
	viewModel.TdbColor(viewModel.user2Colors()[5]);
	viewModel.WColor(viewModel.user2Colors()[6]);
	viewModel.ForegroundColor(viewModel.user2Colors()[7]);
	viewModel.BackgroundColor(viewModel.user2Colors()[8]);
}

function setUser3Colors() {
	viewModel.StateColor(viewModel.user3Colors()[0]);
	viewModel.RHColor(viewModel.user3Colors()[1]);
	viewModel.HColor(viewModel.user3Colors()[2]);
	viewModel.TwbColor(viewModel.user3Colors()[3]);
	viewModel.VColor(viewModel.user3Colors()[4]);
	viewModel.TdbColor(viewModel.user3Colors()[5]);
	viewModel.WColor(viewModel.user3Colors()[6]);
	viewModel.ForegroundColor(viewModel.user3Colors()[7]);
	viewModel.BackgroundColor(viewModel.user3Colors()[8]);
}

function setDefaultInputs (){
	if (viewModel.maxTempInput() != 120)
		viewModel.maxTempInput(120);
	if (viewModel.minTempInput() != 32)
		viewModel.minTempInput(32);
	if (viewModel.maxωInput() != 0.03)
		viewModel.maxωInput(0.03);
	if (viewModel.totalPressureInput() != 14.696)
		viewModel.totalPressureInput(14.696);
}

function setDefaultText (){
	viewModel.xAxisLabel("Dry bulb temperature / °F");
	viewModel.humidityLabel("ω");
	viewModel.yAxisLabel("Vapor Pressure / psia");
	viewModel.enthalpyLabel("Enthalpy / Btu per lb d.a.");

}


//************************************
// https://stackoverflow.com/questions/23218174/how-do-i-save-export-an-svg-file-after-creating-an-svg-with-d3-js-ie-safari-an

function saveSvg(svgEl, name) {
	svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	var svgData = svgEl.outerHTML;
	var preface = '<?xml version="1.0" standalone="no"?>\r\n';
	var svgBlob = new Blob([preface, svgData], {type:"image/svg+xml;charset=utf-8"});
	var svgUrl = URL.createObjectURL(svgBlob);
	var downloadLink = document.createElement("a");
	downloadLink.href = svgUrl;
	downloadLink.download = name;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
}


function showTooltip(evt, text) {
  let tooltip = document.getElementById("tooltip");
  tooltip.innerHTML = text;
  tooltip.style.display = "block";
  tooltip.style.left = evt.pageX + 10 + 'px';
  tooltip.style.top = evt.pageY + 10 + 'px';
}

function hideTooltip() {
  var tooltip = document.getElementById("tooltip");
  tooltip.style.display = "none";
}

ko.bindingHandlers.htmlValue = {
    init: function(element, valueAccessor, allBindingsAccessor) {
        ko.utils.registerEventHandler(element, "blur", function() {
            var modelValue = valueAccessor();
            var elementValue = element.innerHTML;
            if (ko.isWriteableObservable(modelValue)) {
                modelValue(elementValue);
            }
            else { //handle non-observable one-way binding
                var allBindings = allBindingsAccessor();
                if (allBindings['_ko_property_writers'] && allBindings['_ko_property_writers'].htmlValue) allBindings['_ko_property_writers'].htmlValue(elementValue);
            }
        })
    },
    update: function(element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor()) || "";
        element.innerHTML = value;
    }
};

//***************************************************
// Code extracted from 
// https://www.kwangu.com/work/psychrometric.htm
// Jacob Knight Nov 2003
// Based on ASHRAE Fundamentals (SI) 2017 chapter 1

function findpressure(altitude)
{
	if ((altitude<-5000)||(altitude>11000)) alert ("Altitude accurate from -5,000 to 11,000m");
	pressure = 101325*Math.pow(1 - 2.25577e-5*altitude,5.2559);
	return (pressure);
}

function saturation_pressure(t)
{
	var cc1 = -5.6745359e3;
	var cc2 = 6.3925247;
	var cc3 = -9.677843e-3;
	var cc4 = 6.2215701e-7;
	var cc5 = 2.0747825e-9;
	var cc6 = -9.484024e-13;
	var cc7 = 4.1635019;

	var cc8=-5.8002206e3;
	var cc9=1.3914993;
	var cc10=-4.8640239e-2;
	var cc11=4.1764768e-5;
	var cc12=-1.4452093e-8;
	var cc13=6.5459673;

	if (t>0)
	  {
		t=t+273.15;
		pressure=Math.exp(cc8/t+cc9+cc10*t+cc11*t*t+cc12*t*t*t+cc13*Math.log(t));
	  }
	else
	  { 
		t=t+273.15;
		pressure=Math.exp(cc1/t+cc2+cc3*t+cc4*t*t+cc5*t*t*t+cc6*t*t*t*t+cc7*Math.log(t)); 
	  }    
	return(pressure);
}

function humidity_ratio(p_w,p)
{
	hum = 0.621945*p_w/(p-p_w);
	return(hum);
}

function equation_33(t_wb,ws_wb,t)
{
	w=((2501-2.326*t_wb)*ws_wb - 1.006*(t-t_wb))/(2501+1.86*t-4.186*t_wb);
	return(w);
}


function degree_saturation(w,ws)
{
	return(w/ws);
}

function rel_humidity(mew,p_ws,p)
{
	thi=mew/(1.0-(1.0-mew)*(p_ws/p));
	return(thi*100);
}

function specific_volume(t,w,p)
{
	v = 287.042*(t+273.15)*(1+1.607858*w)/p;
	//converted for pressure in Pa not kPa
	return(v);
}

function enthalpy(w,t)
{
	h=1.006*t + w*(2501+1.86*t);
	return(h);
}

function equation_36(p,w)
{
	pressure=p*w/(0.621945+w);
	return(pressure);
}

function dewpoint(p_w)
{
	p_w=p_w/1000.0;
	a = Math.log(p_w);
	cc14=6.54;
	cc15=14.526;
	cc16=0.7389;
	cc17=0.09486;
	cc18=0.4569;

	dew= cc14+cc15*a+cc16*a*a+cc17*a*a*a+cc18*Math.pow(p_w,0.1984);
	if (dew < 0)
	  dew = 6.09 + 12.608*a + 0.4959*a*a;
	  
	return(dew);
}

function density(v,w)
{
	dens=(1.0/v)*(1.0+w);
	return(dens);
}

function calcwetbulb(t,p,w)
{
	t_wb=t;
	count=1;
	error=1.0;
	while ((count < 10000)&&(error > 0.001))
	 {
	   p_ws_wb=saturation_pressure(t_wb);
	   ws_wb=humidity_ratio(p_ws_wb,p);
	   test=(2501*(ws_wb-w)-t*(1.006+1.86*w))/(2.326*ws_wb-1.006-4.186*w);
	   error = t_wb-test;
	   t_wb = t_wb - error/100;
	   count = count+1;
	  }
	if (count > 9999) alert ("calculation error in wet bulb temperature");
	return (t_wb);
}

//***********************************************
