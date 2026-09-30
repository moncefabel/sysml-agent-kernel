package VehicleModel {
    doc /* Simplified vehicle architecture used for agent evaluation. */
    import ScalarValues::*;

    port def FuelPort {
        attribute flowRate : Real;
    }
    port def PowerPort;

    part def Engine {
        attribute mass : Real = 180;
        port fuelIn : FuelPort;
        port powerOut : PowerPort;
    }
    part def ElectricMotor :> Engine {
        attribute peakTorque : Real = 320;
    }
    part def FuelTank {
        attribute capacity : Real = 55;
        port fuelOut : ~FuelPort;
    }
    part def Wheel;
    part def Vehicle {
        part engine : Engine;
        part tank : FuelTank;
        part wheels : Wheel[4];
        connect tank.fuelOut to engine.fuelIn;
    }

    requirement def MassRequirement {
        doc /* The total vehicle mass shall not exceed 2000 kg. */
    }
    requirement vehicleMass : MassRequirement;
    satisfy vehicleMass by Vehicle;
}
