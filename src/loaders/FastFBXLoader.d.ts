import { Loader, LoadingManager, Group } from "three";

export class FBXLoader extends Loader<Group> {
  constructor(manager?: LoadingManager);
  includeMorphTargets: boolean;
  setIncludeMorphTargets(includeMorphTargets: boolean): this;
  parse(FBXBuffer: ArrayBuffer, path: string): Group;
}
