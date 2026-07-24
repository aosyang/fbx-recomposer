import { Loader, LoadingManager, Group } from "three";

export class FBXLoader extends Loader<Group> {
  constructor(manager?: LoadingManager);
  includeMorphTargets: boolean;
  maxMorphTargets: number;
  setIncludeMorphTargets(includeMorphTargets: boolean): this;
  setMaxMorphTargets(maxMorphTargets: number): this;
  parse(FBXBuffer: ArrayBuffer, path: string): Group;
}
